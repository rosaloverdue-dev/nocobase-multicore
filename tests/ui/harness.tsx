/** Renders the real settings page of plugin-multicore with a mock API (window.__api, set by run.mjs). */
import React from 'react';
import { createRoot } from 'react-dom/client';
import PluginMulticoreClient from '../../packages/plugin-multicore/src/client/index';

const app: any = (window as any).__app;
let page: any = null;
app.pluginSettingsManager = { add: (_key: string, options: any) => { page = options; } };
new (PluginMulticoreClient as any)(app).load().then(() => {
  document.title = page.title;
  createRoot(document.getElementById('root')!).render(React.createElement(page.Component));
});
