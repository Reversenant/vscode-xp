import * as fs from 'fs';
import * as os from 'os';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as vscode from 'vscode';
import yaml from 'yaml';

import { DialogHelper } from '../../../helpers/dialogHelper';
import { FileSystemHelper } from '../../../helpers/fileSystemHelper';
import { KbHelper } from '../../../helpers/kbHelper';
import { ProcessHelper } from '../../../helpers/processHelper';
import { Configuration } from '../../../models/configuration';
import { ExceptionHelper } from '../../../helpers/exceptionHelper';
import { ContentTreeBaseItem } from '../../../models/content/contentTreeBaseItem';
import { ContentTreeProvider } from '../contentTreeProvider';
import { UserSettingsManager } from '../../../models/content/userSettingsManager';
import { ViewCommand } from '../../../models/command/command';
import { Log } from '../../../extension';
import { JsHelper } from '../../../helpers/jsHelper';

export class PackKbCommand extends ViewCommand {
	constructor(private config: Configuration, private selectedPackage : ContentTreeBaseItem, private unpackKbFilePath : string) {
		super();
	}

	public async execute() : Promise<void> {
		if(!this.config.isKbOpened()) {
			DialogHelper.showWarning(this.config.getMessage("View.ObjectTree.Message.NeedToOpenKnowledgeBase"));
			return;
		}
		
		if(fs.existsSync(this.unpackKbFilePath)) {
			await fs.promises.unlink(this.unpackKbFilePath);
		}

		// Проверка наличия утилиты сборки kb-файлов.
		const knowledgeBasePackagerCli = this.config.getKbPackFullPath();
		if(!fs.existsSync(knowledgeBasePackagerCli)) {
			DialogHelper.showError(`Путь к утилите сборки kb-файла задан не верно. Проверьте корректность [пути к KBT](command:workbench.action.openSettings?["xpConfig.kbtBaseDirectory"]) или загрузите актуальную версию [отсюда](https://github.com/vxcontrol/xp-kbt/releases), распакуйте и задайте путь к директории [в настройках](command:workbench.action.openSettings?["xpConfig.kbtBaseDirectory"])`);
			return;
		}

		const packageObjectId = this.selectedPackage.getMetaInfo().getObjectId();
		const packageContentPrefixRegExp = /^(\S+?)-/g.exec(packageObjectId);
		if(packageContentPrefixRegExp && packageContentPrefixRegExp.length == 2) {
			const packageContentPrefix = packageContentPrefixRegExp[1];
			const currentContentPrefix = this.config.getContentPrefix();
	
			if(packageContentPrefix !== currentContentPrefix) {
				DialogHelper.showWarning(`Имя поставщика ${currentContentPrefix} не соответствует ObjectId пакета ${packageObjectId}, возможны проблемы при его установке в продукт. Смените имя поставщика или ObjectId пакета`);
			}
		} else {
			DialogHelper.showWarning(`Не удалось выделить префикс контента из ObjectId пакета`);
		}

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			cancellable: false
		}, async (progress) => {
			try {
				// Выводим описание задачи.
				const packageDirPath = this.selectedPackage.getDirectoryPath();
				const packageName = path.basename(packageDirPath);
				progress.report({message: `Сборка пакета '${packageName}'`});

				// Полезно, если путь к директории временных файлов (в домашней директории) будет сокращен тильдой.
				const username = os.userInfo().username;
				Log.info("Username:", username);

				// Исправляем системный путь с тильдой, утилита такого пути не понимает
				let tmpPackageDirectoryPath = this.config.getRandTmpSubDirectoryPath();
				tmpPackageDirectoryPath = FileSystemHelper.resolveTildeWindowsUserHomePath(
					tmpPackageDirectoryPath,
					username);
				
				await fs.promises.mkdir(tmpPackageDirectoryPath, {recursive: true});

				// в objects положить пакет для сборке
				const objectsPackageDirPath = path.join(tmpPackageDirectoryPath, ContentTreeProvider.PACKAGES_DIRNAME, packageName);
				await fs.promises.mkdir(objectsPackageDirPath, {recursive: true});
				await fse.copy(packageDirPath, objectsPackageDirPath);

				// Меняем новые строки \r\n -> \n
				const contentFullPaths = FileSystemHelper.getRecursiveFilesSync(objectsPackageDirPath);
				for(const contentFullPath of contentFullPaths) {
					let content = await fs.promises.readFile(contentFullPath, "utf-8");
					content = KbHelper.convertWindowsEOFToLinux(content);
					await fs.promises.writeFile(contentFullPath, content);
				}

				// Создаем contracts
				const contractsDirPath = path.join(tmpPackageDirectoryPath, Configuration.CONTRACTS_DIR_NAME);
				await fs.promises.mkdir(contractsDirPath, {recursive: true});
				
				// Создаем contracts\origins
				const originsDirPath = path.join(contractsDirPath, PackKbCommand.ORIGIN_DIRNAME);
				await fs.promises.mkdir(originsDirPath, {recursive: true});

				// Проверяем путь к контрактам и копируем их.
				const taxonomyPath = path.join(contractsDirPath, Configuration.TAXONOMY_DIR_NAME);
				await fs.promises.mkdir(taxonomyPath, {recursive: true});
				const сontractsDirectoryPath = this.config.getTaxonomyDirPath();
				await fse.copy(сontractsDirectoryPath, taxonomyPath);

				// Копируем origins из настроек
				const originObject = await UserSettingsManager.getCurrentOrigin(this.config);
				const originString = JsHelper.formatJsonObject(originObject);
				const originsDstDirPath = path.join(originsDirPath, PackKbCommand.ORIGIN_FILENAME);
				await fs.promises.writeFile(originsDstDirPath, originString);

				// Определение пути к папке rules_filters в репозитории
				const rulesFiltersRepoPath = path.join(path.dirname(path.dirname(packageDirPath)), 'common', 'rules_filters');
				
				// Создаем common/rules_filters во временной папке
				const commonRulesFiltersPath = path.join(tmpPackageDirectoryPath, 'common', 'rules_filters');
				await fs.promises.mkdir(commonRulesFiltersPath, { recursive: true });

				// Копируем содержимое common/rules_filters во временную папку
				await fse.copy(rulesFiltersRepoPath, commonRulesFiltersPath);

				// Поиск и удаление папок с метафайлом, содержащим системные идентификаторы
				await this.removeFolders(commonRulesFiltersPath);

				// Типовая команда выглядит так:
				// dotnet kbpack.dll pack -s "c:\tmp\pack" -o "c:\tmp\pack\Esc.kb"
				Log.info("TmpPackageDirectoryPath: ", tmpPackageDirectoryPath);
				const output = await ProcessHelper.execute(
					"dotnet",
					[
						knowledgeBasePackagerCli, 
						"pack", 
						"-s", tmpPackageDirectoryPath, 
						"-o", this.unpackKbFilePath
					],
					{	
						encoding: 'utf-8',
						outputChannel: this.config.getOutputChannel()
					}
				);

				if(output.output.includes(this.successSubstring)) {
					DialogHelper.showInfo(`Пакет '${packageName}' успешно собран`);
					return;
				} 

				DialogHelper.showError(`Ошибка сборки пакета '${packageName}'. [Смотри Output](command:xp.commonCommands.showOutputChannel)`);
				this.config.getOutputChannel().show();
			}
			catch(error) {
				ExceptionHelper.show(error, "Внутренняя ошибка расширения");
			}
		});
	}

	// Принимает путь ко временной папке common/rules_filters
	private async removeFolders(targetFolder: string): Promise<void> {
		try {
			const stats = await fs.promises.stat(targetFolder);
		
			// Если путь существует и это директория
			if (stats.isDirectory()) {
				// Список всех файлов и папок в директории
				const entries = await fs.promises.readdir(targetFolder, { withFileTypes: true });
	
				for (const entry of entries) {
					// Создаем полный путь к текущему элементу
					const entryPath = path.join(targetFolder, entry.name);
	
					// Если это директория, проверяем ее на наличие metainfo
					if (entry.isDirectory()) {
						// Формируем путь к файлу metainfo.yaml в текущей директории
						const metainfoPath = path.join(entryPath, "metainfo.yaml");
	
						try {
							const metainfoStats = await fs.promises.stat(metainfoPath);
	
							// Если файл metainfo существует - считываем содержимое файла
							if (metainfoStats.isFile()) {
								const content = await fs.promises.readFile(metainfoPath, "utf-8");
								// Если содержимое файла содержит строку "ObjectId: PT", удаляем папку
								if (content.includes("ObjectId: PT")) {
									Log.info("Удаление папки: ${entryPath}");
									await fse.remove(entryPath);
								}
							}
						} catch (err) {
							// Если файл metainfo.yaml не существует, игнорируем ошибку ENOENT
							if (err.code !== "ENOENT") {
								Log.error("Ошибка при чтении ${metainfoPath}: ${err}");
							}
						}
	
						// Рекурсивно проверяем подпапки
						await this.removeFolders(entryPath);
					}
				}
			}
		} catch (error) {
			// Логируем ошибку, если произошла ошибка при обработке пути
			Log.error("Ошибка при обработке пути ${targetFolder}:", error);
		}
	}

	public static ORIGIN_FILENAME = "origins.json";
	public static ORIGIN_DIRNAME = "origins";

	private readonly successSubstring = "Knowledge base package creation completed successfully";
}
