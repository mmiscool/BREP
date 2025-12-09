import { renderNumberField } from './numberField.js';
import { renderTextareaField } from './textareaField.js';
import { renderReferenceSelectionField } from './referenceSelectionField.js';
import { renderTransformField } from './transformField.js';
import { renderBooleanOperationField } from './booleanOperationField.js';
import { renderStringField } from './stringField.js';
import { renderBooleanField } from './booleanField.js';
import { renderOptionsField } from './optionsField.js';
import { renderVec3Field } from './vec3Field.js';
import { renderFileField } from './fileField.js';
import { renderButtonField } from './buttonField.js';
import { renderDefaultField } from './defaultField.js';
import { renderComponentSelectorField } from './componentSelectorField.js';
import { renderThreadDesignationField } from './threadDesignationField.js';

const RENDERERS = {
    number: renderNumberField,
    textarea: renderTextareaField,
    reference_selection: renderReferenceSelectionField,
    transform: renderTransformField,
    boolean_operation: renderBooleanOperationField,
    string: renderStringField,
    boolean: renderBooleanField,
    options: renderOptionsField,
    vec3: renderVec3Field,
    file: renderFileField,
    button: renderButtonField,
    component_selector: renderComponentSelectorField,
    thread_designation: renderThreadDesignationField,
};

export function getWidgetRenderer(type) {
    return RENDERERS[type] || renderDefaultField;
}
