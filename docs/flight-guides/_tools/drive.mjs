/**
 * Puts a screen into a state that only real use can reach.
 *
 * A few pictures are of states the app enters after the user does
 * something: picking a board from the searchable list, moving to the
 * second stage of the flasher, arming a safety switch. Those states are
 * reached here by CLICKING THE REAL CONTROLS, never by pushing values
 * into the component - so the picture stays a picture of the app.
 *
 * Shared by capture.mjs and validate.mjs so a screenshot and its check
 * always look at the same state.
 */

/** Runs a step's `prepare: [{click: 'testid'}, ...]` list. */
export async function prepare(page, actions = []) {
  for (const action of actions) {
    const target = page.locator(`[data-testid="${action.click}"]`).first();
    await target.waitFor({state: 'visible', timeout: 8000});
    await target.click();
    await page.waitForTimeout(action.settle ?? 450);
  }
}
