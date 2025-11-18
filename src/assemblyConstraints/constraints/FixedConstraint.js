import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';

const inputParamsSchema = {
  id: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the constraint.',
  },
  component: {
    type: 'reference_selection',
    label: 'Component',
    hint: 'Select the component that should remain fixed in the assembly.',
    selectionFilter: ['COMPONENT'],
  },
};


export class FixedConstraint extends BaseAssemblyConstraint {
  static shortName = '⏚';
  static longName = '⏚ Fixed Constraint';
  static constraintType = 'fixed';
  static aliases = ['fix', 'fixed constraint', 'fixed', 'FIXD'];
  static inputParamsSchema = inputParamsSchema;

  async solve(context = {}) {
    const pd = this.persistentData = this.persistentData || {};
    const selection = firstSelection(this.inputParams.component);
    const component = context.resolveComponent?.(selection) || context.resolveObject?.(selection);

    if (!component || !component.isAssemblyComponent) {
      pd.status = 'incomplete';
      pd.message = 'Select an assembly component to fix in place.';
      pd.satisfied = false;
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    const wasFixed = context.isComponentFixed ? context.isComponentFixed(component) : !!component.fixed;

    component.fixed = true;
    component.userData = component.userData || {};
    component.userData.fixedByConstraint = true;

    const feature = context.getFeatureForComponent?.(component);
    if (feature) {
      feature.inputParams = feature.inputParams || {};
      feature.inputParams.isFixed = true;
    }

    const message = wasFixed
      ? 'Component already marked as fixed.'
      : 'Component locked in place by constraint.';

    pd.status = 'satisfied';
    pd.message = message;
    pd.satisfied = true;
    pd.error = 0;
    pd.componentName = component.name || component.owningFeatureID || null;

    return {
      ok: true,
      status: 'satisfied',
      satisfied: true,
      applied: !wasFixed,
      error: 0,
      message,
    };
  }

  async run(context = {}) {
    return this.solve(context);
  }
}


function firstSelection(value) {
  if (!value) return null;
  return Array.isArray(value) ? value.find((item) => item != null) ?? null : value;
}
