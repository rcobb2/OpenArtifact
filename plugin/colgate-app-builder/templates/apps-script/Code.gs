/**
 * Server side of a Colgate App Foundry Apps Script app.
 *
 * Runs as USER_ACCESSING (see appsscript.json), so every call below executes
 * with the permissions of whoever opened the app — never the deployer's. That
 * is what makes it safe to share across campus: the app cannot surface data
 * the viewer could not already reach.
 */

/** Entry point. Serves the single-file React bundle. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Colgate App')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Who is using the app right now. */
function getCurrentUser() {
  return { email: Session.getActiveUser().getEmail() };
}

/**
 * Example data call, invoked from the UI via google.script.run.
 * Replace with the app's real logic; keep each entry point small and named
 * for what it does, so the scopes it needs stay obvious.
 */
function readSheet(spreadsheetId, rangeA1) {
  var values = SpreadsheetApp.openById(spreadsheetId).getRange(rangeA1).getValues();
  return { values: values };
}

/**
 * Secrets belong here, not in source or in the client bundle:
 *   PropertiesService.getScriptProperties().getProperty('SOME_KEY')
 * Set them once in the Apps Script editor under Project Settings.
 */
