/**
 * Typed wrapper around google.script.run.
 *
 * Keeping every server call behind this one module means the set of Apps
 * Script entry points the UI depends on — and therefore the OAuth scopes the
 * app needs — can be read off in one place.
 */
declare const google: {
  script: {
    run: {
      withSuccessHandler(cb: (v: unknown) => void): typeof google.script.run;
      withFailureHandler(cb: (e: Error) => void): typeof google.script.run;
      [fn: string]: (...args: unknown[]) => void;
    };
  };
};

export function call<T>(fn: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof google === 'undefined') {
      reject(new Error(`Not running inside Apps Script — "${fn}" is unavailable in vite dev.`));
      return;
    }
    google.script.run
      .withSuccessHandler((v) => resolve(v as T))
      .withFailureHandler(reject)[fn](...args);
  });
}

export const getCurrentUser = () => call<{ email: string }>('getCurrentUser');
export const readSheet = (id: string, range: string) =>
  call<{ values: string[][] }>('readSheet', id, range);
