/** Stand-in for @nocobase/client: the three things the settings page imports. */
export class Plugin {
  app: any;
  constructor(app: any) {
    this.app = app;
  }
}
export const useApp = () => (window as any).__app;
export const useAPIClient = () => (window as any).__api;
