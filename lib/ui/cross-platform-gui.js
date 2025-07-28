const { app, BrowserWindow, ipcMain, Menu, Tray, dialog } = require('electron');
const path = require('path');
const { EventEmitter } = require('events');

class CrossPlatformGUI extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            width: options.width || 1200,
            height: options.height || 800,
            darkMode: options.darkMode !== false,
            autoStart: options.autoStart || false,
            minimizeToTray: options.minimizeToTray !== false,
            multiWindow: options.multiWindow !== false,
            updateInterval: options.updateInterval || 1000,
            ...options
        };
        
        this.mainWindow = null;
        this.tray = null;
        this.windows = new Map();
        this.miningData = {};
        this.isQuitting = false;
        
        this.setupApp();
    }

    setupApp() {
        app.whenReady().then(() => {
            this.createMainWindow();
            this.createTray();
            this.setupIPC();
            this.startDataSync();
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.createMainWindow();
            }
        });

        app.on('before-quit', () => {
            this.isQuitting = true;
        });
    }

    createMainWindow() {
        this.mainWindow = new BrowserWindow({
            width: this.config.width,
            height: this.config.height,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            frame: false,
            titleBarStyle: 'hiddenInset',
            icon: this.getIconPath(),
            show: false
        });

        this.mainWindow.loadFile(path.join(__dirname, 'index.html'));

        this.mainWindow.once('ready-to-show', () => {
            this.mainWindow.show();
            if (this.config.darkMode) {
                this.mainWindow.webContents.send('theme:set', 'dark');
            }
        });

        this.mainWindow.on('close', (event) => {
            if (!this.isQuitting && this.config.minimizeToTray) {
                event.preventDefault();
                this.mainWindow.hide();
            }
        });

        this.setupMenu();
    }

    createTray() {
        if (!this.config.minimizeToTray) return;

        this.tray = new Tray(this.getIconPath());
        
        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Show Otedama',
                click: () => this.mainWindow.show()
            },
            {
                label: 'Start Mining',
                click: () => this.emit('mining:start')
            },
            {
                label: 'Stop Mining',
                click: () => this.emit('mining:stop')
            },
            { type: 'separator' },
            {
                label: 'Quit',
                click: () => {
                    this.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        this.tray.setToolTip('Otedama Mining Platform');
        this.tray.setContextMenu(contextMenu);
        
        this.tray.on('click', () => {
            this.mainWindow.isVisible() ? this.mainWindow.hide() : this.mainWindow.show();
        });
    }

    setupMenu() {
        const template = [
            {
                label: 'File',
                submenu: [
                    {
                        label: 'New Window',
                        accelerator: 'CmdOrCtrl+N',
                        click: () => this.createWindow('dashboard')
                    },
                    { type: 'separator' },
                    {
                        label: 'Quit',
                        accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                        click: () => app.quit()
                    }
                ]
            },
            {
                label: 'View',
                submenu: [
                    {
                        label: 'Dashboard',
                        click: () => this.showView('dashboard')
                    },
                    {
                        label: 'Mining Status',
                        click: () => this.showView('mining')
                    },
                    {
                        label: 'Pool Management',
                        click: () => this.showView('pools')
                    },
                    {
                        label: 'Hardware Monitor',
                        click: () => this.showView('hardware')
                    },
                    {
                        label: 'Profit Analysis',
                        click: () => this.showView('profit')
                    },
                    { type: 'separator' },
                    {
                        label: 'Toggle Dark Mode',
                        accelerator: 'CmdOrCtrl+D',
                        click: () => this.toggleDarkMode()
                    },
                    { role: 'togglefullscreen' }
                ]
            },
            {
                label: 'Tools',
                submenu: [
                    {
                        label: 'Settings',
                        accelerator: 'CmdOrCtrl+,',
                        click: () => this.showSettings()
                    },
                    {
                        label: 'Console',
                        accelerator: 'CmdOrCtrl+Shift+C',
                        click: () => this.showConsole()
                    },
                    { type: 'separator' },
                    { role: 'toggleDevTools' }
                ]
            },
            {
                label: 'Help',
                submenu: [
                    {
                        label: 'Documentation',
                        click: () => this.openDocumentation()
                    },
                    {
                        label: 'About',
                        click: () => this.showAbout()
                    }
                ]
            }
        ];

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
    }

    setupIPC() {
        // Mining controls
        ipcMain.handle('mining:start', async (event, config) => {
            this.emit('mining:start', config);
            return { success: true };
        });

        ipcMain.handle('mining:stop', async () => {
            this.emit('mining:stop');
            return { success: true };
        });

        // Data requests
        ipcMain.handle('data:get', async (event, type) => {
            switch (type) {
                case 'mining':
                    return this.miningData;
                case 'hardware':
                    return this.getHardwareData();
                case 'pools':
                    return this.getPoolData();
                case 'profit':
                    return this.getProfitData();
                default:
                    return null;
            }
        });

        // Settings
        ipcMain.handle('settings:get', async () => {
            return this.config;
        });

        ipcMain.handle('settings:save', async (event, settings) => {
            Object.assign(this.config, settings);
            this.emit('settings:changed', settings);
            return { success: true };
        });

        // Window controls
        ipcMain.on('window:minimize', () => {
            BrowserWindow.getFocusedWindow()?.minimize();
        });

        ipcMain.on('window:maximize', () => {
            const window = BrowserWindow.getFocusedWindow();
            if (window?.isMaximized()) {
                window.unmaximize();
            } else {
                window?.maximize();
            }
        });

        ipcMain.on('window:close', () => {
            BrowserWindow.getFocusedWindow()?.close();
        });

        // View navigation
        ipcMain.on('view:navigate', (event, view) => {
            this.showView(view);
        });

        // Notifications
        ipcMain.handle('notification:show', async (event, options) => {
            return this.showNotification(options);
        });
    }

    startDataSync() {
        setInterval(() => {
            // Send updated data to all windows
            const data = {
                mining: this.miningData,
                timestamp: Date.now()
            };

            for (const window of BrowserWindow.getAllWindows()) {
                window.webContents.send('data:update', data);
            }
        }, this.config.updateInterval);
    }

    updateMiningData(data) {
        this.miningData = {
            ...this.miningData,
            ...data,
            lastUpdate: Date.now()
        };

        // Send immediate update
        for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('mining:update', this.miningData);
        }
    }

    createWindow(type) {
        if (!this.config.multiWindow) {
            this.showView(type);
            return;
        }

        const window = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            frame: false,
            titleBarStyle: 'hiddenInset'
        });

        window.loadFile(path.join(__dirname, `${type}.html`));
        
        const windowId = `${type}_${Date.now()}`;
        this.windows.set(windowId, window);

        window.on('closed', () => {
            this.windows.delete(windowId);
        });
    }

    showView(view) {
        this.mainWindow.webContents.send('view:change', view);
    }

    toggleDarkMode() {
        this.config.darkMode = !this.config.darkMode;
        const theme = this.config.darkMode ? 'dark' : 'light';
        
        for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('theme:set', theme);
        }
    }

    showSettings() {
        if (this.windows.has('settings')) {
            this.windows.get('settings').focus();
            return;
        }

        const settingsWindow = new BrowserWindow({
            width: 600,
            height: 500,
            parent: this.mainWindow,
            modal: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
        this.windows.set('settings', settingsWindow);

        settingsWindow.on('closed', () => {
            this.windows.delete('settings');
        });
    }

    showConsole() {
        if (this.windows.has('console')) {
            this.windows.get('console').focus();
            return;
        }

        const consoleWindow = new BrowserWindow({
            width: 800,
            height: 400,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        consoleWindow.loadFile(path.join(__dirname, 'console.html'));
        this.windows.set('console', consoleWindow);

        consoleWindow.on('closed', () => {
            this.windows.delete('console');
        });
    }

    showNotification(options) {
        const { title, body, icon, actions } = options;

        if (Notification.isSupported()) {
            const notification = new Notification({
                title,
                body,
                icon: icon || this.getIconPath(),
                actions: actions || []
            });

            notification.show();
            
            return { success: true };
        }

        return { success: false, error: 'Notifications not supported' };
    }

    showAbout() {
        dialog.showMessageBox(this.mainWindow, {
            type: 'info',
            title: 'About Otedama',
            message: 'Otedama Mining Platform',
            detail: 'Professional cryptocurrency mining management system\n\nVersion: 1.0.0\n© 2024 Otedama',
            buttons: ['OK']
        });
    }

    openDocumentation() {
        require('electron').shell.openExternal('https://docs.otedama.io');
    }

    getIconPath() {
        const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
        return path.join(__dirname, 'assets', iconName);
    }

    getHardwareData() {
        // This would be populated by the hardware monitoring system
        return {
            gpus: [],
            cpu: {},
            memory: {},
            temperature: {}
        };
    }

    getPoolData() {
        // This would be populated by the pool manager
        return {
            connected: [],
            available: [],
            statistics: {}
        };
    }

    getProfitData() {
        // This would be populated by the profit analyzer
        return {
            current: 0,
            daily: 0,
            weekly: 0,
            monthly: 0,
            history: []
        };
    }

    async exportData(type, format) {
        const data = await this.getData(type);
        
        const { filePath } = await dialog.showSaveDialog(this.mainWindow, {
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'CSV', extensions: ['csv'] }
            ]
        });

        if (!filePath) return;

        // Export logic would go here
        this.emit('data:exported', { type, format, filePath });
    }

    async importSettings() {
        const { filePaths } = await dialog.showOpenDialog(this.mainWindow, {
            filters: [
                { name: 'JSON', extensions: ['json'] }
            ],
            properties: ['openFile']
        });

        if (filePaths.length === 0) return;

        // Import logic would go here
        this.emit('settings:imported', { filePath: filePaths[0] });
    }

    quit() {
        this.isQuitting = true;
        app.quit();
    }
}

module.exports = CrossPlatformGUI;