import { requireModelRecord } from '../services/modelLoadErrors.js';

export async function test_file_manager_missing_model_rejects_without_alert() {
  const previousAlert = globalThis.alert;
  let alertCalls = 0;
  globalThis.alert = () => {
    alertCalls += 1;
  };

  try {
    let error = null;
    try {
      requireModelRecord('examples/missing-model.3mf', null);
    } catch (caught) {
      error = caught;
    }

    if (!(error instanceof Error)) {
      throw new Error('Expected a missing model to reject the programmatic load request');
    }
    if (error.message !== 'Model not found: "examples/missing-model.3mf"') {
      throw new Error(`Unexpected missing-model error: ${error.message}`);
    }
    if (alertCalls !== 0) {
      throw new Error(`Expected no blocking alert, received ${alertCalls}`);
    }
  } finally {
    if (previousAlert === undefined) {
      delete globalThis.alert;
    } else {
      globalThis.alert = previousAlert;
    }
  }
}
