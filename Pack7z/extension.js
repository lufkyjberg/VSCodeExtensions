const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

/*
 * Текущий открытый QuickPick.
 *
 * Нужен для того, чтобы отдельная команда,
 * привязанная к Tab, понимала, с каким окном работать.
 */
let currentPicker = null;

/*
 * Последний активный элемент.
 *
 * Обновляется при перемещении стрелками ↑ / ↓.
 * Это нужно, чтобы Tab сразу работал после перемещения.
 */
let currentActiveItem = null;

/*
 * ---------------------------------------------------------
 * Путь до 7-Zip
 * ---------------------------------------------------------
 */
function get7zPath() {
  /*
   * Стандартный путь установки 7-Zip.
   */
  const standardPath = "C:\\Program Files\\7-Zip\\7z.exe";

  /*
   * Если 7z.exe находится там —
   * используем полный путь.
   */
  if (fs.existsSync(standardPath)) {
    return standardPath;
  }

  /*
   * Иначе пробуем просто "7z".
   *
   * Это сработает, если 7-Zip добавлен в PATH.
   */
  return "7z";
}

/*
 * ---------------------------------------------------------
 * Генерация имени архива
 * ---------------------------------------------------------
 *
 * Получится, например:
 *
 * selected_2026-09-21_15-32-45.7z
 */
function getArchiveName() {
  const now = new Date();

  /*
   * Добавляем 0 слева.
   *
   * 5 -> 05
   * 12 -> 12
   */
  const pad = (number) => String(number).padStart(2, "0");

  const year = now.getFullYear();

  const month = pad(now.getMonth() + 1);

  const day = pad(now.getDate());

  const hour = pad(now.getHours());

  const minute = pad(now.getMinutes());

  const second = pad(now.getSeconds());

  return `selected_${year}-${month}-${day}` + `_${hour}-${minute}-${second}.7z`;
}

/*
 * ---------------------------------------------------------
 * Создание архива
 * ---------------------------------------------------------
 */
async function createArchive(rootPath, selectedItems) {
  /*
   * Генерируем имя архива.
   */
  const archiveName = getArchiveName();

  /*
   * Полный путь архива.
   *
   * Например:
   *
   * C:\Project\selected_2026-09-21_15-32-45.7z
   */
  const archivePath = path.join(rootPath, archiveName);

  /*
   * Создаём временный список файлов.
   *
   * Он будет лежать в Windows TEMP.
   *
   * Например:
   *
   * C:\Users\User\AppData\Local\Temp\
   * pack7z_123456789.txt
   */
  const listFile = path.join(os.tmpdir(), `pack7z_${Date.now()}.txt`);

  /*
   * Записываем ОТНОСИТЕЛЬНЫЕ пути.
   *
   * Например:
   *
   * panels\Schemes\Diag\diag_snmp.xml
   * dplist\DIAG_ARM001.dpl
   *
   * Благодаря этому внутри 7z
   * сохраняется структура папок.
   */
  const fileList = selectedItems
    .map((item) => `"${item.relativePath}"`)
    .join("\r\n");

  /*
   * Создаём временный txt.
   */
  fs.writeFileSync(listFile, fileList, "utf8");

  /*
   * Получаем путь до 7z.exe.
   */
  const sevenZip = get7zPath();

  /*
   * Аргументы 7-Zip.
   *
   * Фактически получится:
   *
   * 7z a archive.7z @list.txt -scsUTF-8
   */
  const args = ["a", archivePath, `@${listFile}`, "-scsUTF-8"];

  /*
   * Запускаем 7-Zip.
   *
   * cwd = корень проекта.
   *
   * Это важно:
   * именно благодаря этому относительные пути
   * корректно сохраняются внутри архива.
   */
  const process7z = spawn(sevenZip, args, {
    cwd: rootPath,
    windowsHide: true,
  });

  let errorOutput = "";

  let processFailed = false;

  /*
   * Сохраняем stderr.
   */
  process7z.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });

  /*
   * Если 7z вообще не удалось запустить.
   *
   * Например:
   *
   * 7-Zip не установлен.
   */
  process7z.on("error", (error) => {
    processFailed = true;

    /*
     * Удаляем временный список.
     */
    if (fs.existsSync(listFile)) {
      fs.unlinkSync(listFile);
    }

    vscode.window.showErrorMessage(
      "Не удалось запустить 7-Zip: " + error.message,
    );
  });

  /*
   * Когда 7-Zip закончил работу.
   */
  process7z.on("close", async (code) => {
    /*
     * Если уже произошла ошибка запуска —
     * второй раз сообщение не показываем.
     */
    if (processFailed) {
      return;
    }

    /*
     * Удаляем временный список.
     */
    if (fs.existsSync(listFile)) {
      fs.unlinkSync(listFile);
    }

    /*
     * Ненулевой код =
     * 7-Zip завершился с ошибкой.
     */
    if (code !== 0) {
      vscode.window.showErrorMessage(
        `7-Zip завершился с ошибкой ${code}. ` + errorOutput,
      );

      return;
    }

    /*
     * Архив успешно создан.
     */
    const action = await vscode.window.showInformationMessage(
      `Создан ${archiveName} ` + `(${selectedItems.length} файлов)`,

      "Показать",
    );

    /*
     * Можно сразу открыть проводник
     * и выделить созданный архив.
     */
    if (action === "Показать") {
      vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(archivePath),
      );
    }
  });
}

/*
 * ---------------------------------------------------------
 * Активация расширения
 * ---------------------------------------------------------
 */
function activate(context) {
  /*
   * =====================================================
   * ГЛАВНАЯ КОМАНДА
   * =====================================================
   *
   * Открывает окно выбора файлов.
   *
   * В package.json она привязана,
   * например, к:
   *
   * Ctrl + Alt + 7
   */
  const pickCommand = vscode.commands.registerCommand(
    "pack7z.pickFiles",

    async () => {
      /*
       * Получаем открытые папки VS Code.
       */
      const folders = vscode.workspace.workspaceFolders;

      /*
       * Если папка проекта
       * вообще не открыта.
       */
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(
          "Сначала открой папку " + "проекта в VS Code.",
        );

        return;
      }

      /*
       * Берём первую открытую папку
       * как корень проекта.
       */
      const root = folders[0].uri;

      const rootPath = root.fsPath;

      /*
       * =================================================
       * ИЩЕМ ФАЙЛЫ
       * =================================================
       *
       * RelativePattern нужен, чтобы искать
       * только внутри нашего rootPath.
       */
      const pattern = new vscode.RelativePattern(root, "**/*");

      /*
       * Не показываем содержимое:
       *
       * .git
       * node_modules
       */
      const exclude = "**/{.git,node_modules}/**";

      const files = await vscode.workspace.findFiles(pattern, exclude);

      /*
       * Дополнительная фильтрация.
       */
      const filteredFiles = files.filter((uri) => {
        const relative = path.relative(rootPath, uri.fsPath);

        /*
         * Уже созданные .7z
         * в список не показываем.
         */
        if (relative.toLowerCase().endsWith(".7z")) {
          return false;
        }

        return true;
      });

      /*
       * =================================================
       * СОЗДАЁМ ЭЛЕМЕНТЫ QUICK PICK
       * =================================================
       */
      const items = filteredFiles.map((uri) => {
        /*
         * Относительный путь.
         */
        const relativePath = path.relative(rootPath, uri.fsPath);

        return {
          /*
           * Имя файла.
           *
           * Например:
           *
           * diag_snmp.xml
           */
          label: path.basename(relativePath),

          /*
           * Папка.
           *
           * Например:
           *
           * panels\Schemes\Diag
           */
          description: path.dirname(relativePath),

          /*
           * Полный относительный путь.
           */
          detail: relativePath,

          /*
           * Сохраняем URI.
           */
          uri: uri,

          /*
           * Путь понадобится
           * при создании архива.
           */
          relativePath: relativePath,
        };
      });

      /*
       * Сортируем по полному пути.
       */
      items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

      /*
       * =================================================
       * СОЗДАЁМ QUICK PICK
       * =================================================
       */
      const picker = vscode.window.createQuickPick();

      /*
       * Запоминаем его глобально,
       * чтобы команда Tab могла
       * получить к нему доступ.
       */
      currentPicker = picker;

      /*
       * Разрешаем выбирать
       * несколько файлов.
       *
       * VS Code покажет checkbox'ы.
       */
      picker.canSelectMany = true;

      /*
       * Передаём список файлов.
       */
      picker.items = items;

      /*
       * =================================================
       * СРАЗУ АКТИВИРУЕМ ПЕРВЫЙ ФАЙЛ
       * =================================================
       *
       * Поэтому после открытия окна
       * можно сразу нажать Tab.
       */
      if (items.length > 0) {
        picker.activeItems = [items[0]];

        currentActiveItem = items[0];
      }

      picker.title = "Файлы для 7z";

      picker.placeholder = "Начни вводить имя файла...";

      /*
       * Поиск будет учитывать
       * не только label,
       * но и путь.
       */
      picker.matchOnDescription = true;

      picker.matchOnDetail = true;

      /*
       * =================================================
       * СЛЕДИМ ЗА ↑ / ↓
       * =================================================
       *
       * Каждый раз, когда пользователь
       * передвигается стрелками,
       * запоминаем текущий файл.
       *
       * Это исправляет проблему,
       * когда после стрелки Tab
       * срабатывал только со второго раза.
       */
      picker.onDidChangeActive((activeItems) => {
        currentActiveItem = activeItems[0] || null;
      });

      /*
       * =================================================
       * АВТОМАТИЧЕСКИЙ ФОКУС
       * НА ПЕРВОМ НАЙДЕННОМ
       * =================================================
       *
       * Например:
       *
       * вводишь:
       *
       * diag snmp
       *
       * первый подходящий файл
       * сразу становится активным.
       *
       * При этом ↑ / ↓ продолжают
       * работать совершенно нормально.
       */
      picker.onDidChangeValue((value) => {
        const query = value.trim().toLowerCase();

        /*
         * Если поиск очистили —
         * снова активируем
         * первый файл.
         */
        if (!query) {
          if (items.length > 0) {
            picker.activeItems = [items[0]];

            currentActiveItem = items[0];
          }

          return;
        }

        /*
         * Позволяет искать:
         *
         * diag snmp
         *
         * как два отдельных слова.
         */
        const words = query.split(/\s+/);

        /*
         * Ищем первый файл,
         * содержащий все слова.
         */
        const firstMatch = items.find((item) => {
          const text = [
            item.label || "",
            item.description || "",
            item.detail || "",
          ]
            .join(" ")
            .toLowerCase();

          return words.every((word) => text.includes(word));
        });

        /*
         * Найден первый подходящий файл.
         *
         * Делаем его активным.
         */
        if (firstMatch) {
          picker.activeItems = [firstMatch];

          currentActiveItem = firstMatch;
        }
      });

      /*
       * =================================================
       * ВКЛЮЧАЕМ КОНТЕКСТ ДЛЯ TAB
       * =================================================
       *
       * package.json содержит:
       *
       * "when": "pack7zPickerOpen"
       *
       * Поэтому Tab перехватывается
       * только пока открыто это окно.
       */
      await vscode.commands.executeCommand(
        "setContext",
        "pack7zPickerOpen",
        true,
      );

      /*
       * =================================================
       * ENTER
       * =================================================
       *
       * Enter создаёт архив
       * из отмеченных файлов.
       */
      picker.onDidAccept(async () => {
        let selected = Array.from(picker.selectedItems);

        /*
         * Если галочками ничего
         * не выбрано,
         *
         * но есть активный файл —
         * архивируем его одного.
         */
        if (selected.length === 0) {
          const active = picker.activeItems[0] || currentActiveItem;

          if (active) {
            selected = [active];
          }
        }

        /*
         * Вообще ничего нет.
         */
        if (selected.length === 0) {
          return;
        }

        /*
         * Закрываем окно.
         */
        picker.hide();

        /*
         * Создаём архив.
         */
        await createArchive(rootPath, selected);
      });

      /*
       * =================================================
       * ЗАКРЫТИЕ QUICK PICK
       * =================================================
       *
       * Например по Esc.
       */
      picker.onDidHide(async () => {
        currentPicker = null;

        currentActiveItem = null;

        /*
         * Возвращаем обычное
         * поведение Tab.
         */
        await vscode.commands.executeCommand(
          "setContext",
          "pack7zPickerOpen",
          false,
        );

        /*
         * Освобождаем QuickPick.
         */
        picker.dispose();
      });

      /*
       * Наконец показываем окно.
       */
      picker.show();
    },
  );

  /*
   * =====================================================
   * КОМАНДА TAB
   * =====================================================
   *
   * Отмечает текущий файл
   * или снимает с него галочку.
   */
  const toggleCommand = vscode.commands.registerCommand(
    "pack7z.toggleSelection",

    () => {
      /*
       * Наш QuickPick
       * сейчас не открыт.
       */
      if (!currentPicker) {
        return;
      }

      /*
       * setTimeout(..., 0)
       *
       * Даёт VS Code закончить
       * обработку предыдущего ↑ / ↓,
       *
       * а уже потом выполняет Tab.
       */
      setTimeout(
        () => {
          /*
           * За это время окно
           * могло закрыться.
           */
          if (!currentPicker) {
            return;
          }

          /*
           * Берём максимально
           * актуальный активный файл.
           */
          const active = currentPicker.activeItems[0] || currentActiveItem;

          if (!active) {
            return;
          }

          /*
           * Получаем уже отмеченные
           * элементы.
           */
          const selected = Array.from(currentPicker.selectedItems);

          /*
           * Проверяем,
           * выбран ли active.
           */
          const index = selected.indexOf(active);

          /*
           * Если уже выбран —
           * снимаем галочку.
           */
          if (index !== -1) {
            selected.splice(index, 1);
          } else {

          /*
           * Если не выбран —
           * ставим галочку.
           */
            selected.push(active);
          }

          /*
           * Обновляем список
           * выбранных файлов.
           */
          currentPicker.selectedItems = selected;

          /*
           * И оставляем активным
           * тот же файл.
           *
           * Фокус никуда
           * не прыгает.
           */
          currentPicker.activeItems = [active];

          currentActiveItem = active;
        },

        0,
      );
    },
  );

  /*
   * Регистрируем команды,
   * чтобы VS Code корректно
   * уничтожил их при выгрузке.
   */
  context.subscriptions.push(pickCommand, toggleCommand);
}

/*
 * Вызывается при отключении расширения.
 */
function deactivate() {}

/*
 * Экспортируем функции
 * для VS Code.
 */
module.exports = {
  activate,
  deactivate,
};
