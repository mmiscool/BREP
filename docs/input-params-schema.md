# Input Params Schema

Feature, PMI annotation, and assembly constraint dialogs are rendered from an `inputParamsSchema` object by `SchemaForm` (`src/UI/featureDialogs.js`). Each key in the schema corresponds to a param entry; the widget type and its options are driven by the definition object.

```js
const inputParamsSchema = {
  distance: {
    type: 'number',
    label: 'Distance',
    default_value: 10, // Optional
    step: 0.1, // Optional
    min: 0, // Optional
  },
  profile: {
    type: 'reference_selection',
    label: 'Profile',
    selectionFilter: ['FACE', 'SKETCH'],
    multiple: false, // Optional
  },
};
```

`SchemaForm` clones `default_value` when seeding `params`; when a default is omitted it falls back to `false` for booleans, `''` for most text/select fields, `null` for single reference selections, `{ position:[0,0,0], rotationEuler:[0,0,0], scale:[1,1,1] }` for transforms, and `[0,0,0]` for vec3. Keys `id` and `featureID` are reserved and not rendered. You can override rendering with `renderWidget` or `widgetRenderer` (a function that receives `{ ui, key, def, id, controlWrap, row }`). PMI annotations also honor `defaultResolver({ pmimode, handler })` for dynamic defaults.

## Selection filters for references

`reference_selection` widgets call `SelectionFilter.SetSelectionTypes(def.selectionFilter)`. Valid tokens come from `SelectionFilter.TYPES`: `SOLID`, `COMPONENT`, `FACE`, `PLANE`, `SKETCH`, `EDGE`, `LOOP`, `VERTEX`, or `ALL` (to allow any scene pick).

## Widget types

### string
- Required: `type: 'string'`, `label`
- Optional: `default_value`, `hint`
- Behavior: single-line text box.
- Example:
```js
title: {
  type: 'string',
  label: 'Title',
  default_value: 'My feature', // Optional
  hint: 'Shown in the tree', // Optional
}
```

### textarea
- Required: `type: 'textarea'`, `label`
- Optional: `default_value`, `hint`, `rows`, `placeholder`
- Behavior: multi-line text area with optional placeholder.
- Example:
```js
note: {
  type: 'textarea',
  label: 'Note',
  rows: 3, // Optional
  placeholder: 'Enter notes…', // Optional
}
```

### number
- Required: `type: 'number'`, `label`
- Optional: `default_value`, `hint`, `step`, `min`, `max`
- Behavior: numeric input that flips to text when the value looks like an expression.
- Example:
```js
distance: {
  type: 'number',
  label: 'Distance',
  default_value: 5, // Optional
  step: 0.01, // Optional
  min: 0, // Optional
  max: 100, // Optional
}
```

### boolean
- Required: `type: 'boolean'`, `label`
- Optional: `default_value`, `hint`
- Behavior: checkbox storing a boolean.
- Example:
```js
copy: {
  type: 'boolean',
  label: 'Create copy',
  default_value: false, // Optional
  hint: 'Duplicates instead of replacing', // Optional
}
```

### options
- Required: `type: 'options'`, `label`, `options` (array of string values)
- Optional: `default_value`, `hint`
- Behavior: `<select>` with provided options; stored value is the selected string.
- Example:
```js
mode: {
  type: 'options',
  label: 'Space',
  options: ['WORLD', 'LOCAL'],
  default_value: 'WORLD', // Optional
  hint: 'Choose frame', // Optional
}
```

### reference_selection
- Required: `type: 'reference_selection'`, `label`, `selectionFilter` (see tokens above)
- Optional: `default_value`, `hint`, `multiple`, `minSelections`, `maxSelections`, `placeholder`
- Behavior: single-select shows a button with clear control; multi-select shows chips plus a hidden input. Values are normalized reference names; multi-select stores an array. `minSelections`/`maxSelections` enforce counts when chips render.
- Example:
```js
profile: {
  type: 'reference_selection',
  label: 'Profile',
  selectionFilter: ['FACE', 'SKETCH'],
  multiple: false, // Optional
  default_value: null, // Optional
  hint: 'Pick a face or sketch', // Optional
  placeholder: 'Click then pick…', // Optional
},
targets: {
  type: 'reference_selection',
  label: 'Targets',
  selectionFilter: ['SOLID'],
  multiple: true, // Optional
  minSelections: 1, // Optional
  maxSelections: 4, // Optional
  default_value: [], // Optional
  placeholder: 'Pick solids…', // Optional
  hint: 'Set boolean targets', // Optional
}
```

### transform
- Required: `type: 'transform'`, `label`
- Optional: `default_value`, `hint`
- Behavior: launches the transform gizmo plus numeric grid. Value shape `{ position:[x,y,z], rotationEuler:[rx,ry,rz], scale:[sx,sy,sz] }`.
- Example:
```js
transform: {
  type: 'transform',
  label: 'Placement',
  hint: 'Use the gizmo', // Optional
  default_value: {
    position: [0, 0, 0],
    rotationEuler: [0, 0, 0],
    scale: [1, 1, 1],
  }, // Optional
}
```

### vec3
- Required: `type: 'vec3'`, `label`
- Optional: `default_value`, `hint`, `step`, `uniformToggle`, `uniformDefault`, `uniformLockLabel`
- Behavior: three-number row; when `uniformToggle` is true a checkbox can lock all three values together.
- Example:
```js
scale: {
  type: 'vec3',
  label: 'Scale',
  default_value: [1, 1, 1], // Optional
  step: 0.1, // Optional
  uniformToggle: true, // Optional
  uniformDefault: true, // Optional
  uniformLockLabel: 'Uniform scale', // Optional
  hint: 'Set per-axis scale', // Optional
}
```

### boolean_operation
- Required: `type: 'boolean_operation'`, `label`
- Optional: `default_value` (expects `{ targets: [], operation: 'NONE' }`), `options` (operation list), `hint`
- Behavior: dropdown of operations plus a multi-reference chip list fixed to `SOLID` selection filtering.
- Example:
```js
boolean: {
  type: 'boolean_operation',
  label: 'Boolean',
  default_value: { targets: [], operation: 'NONE' }, // Optional
  options: ['NONE', 'UNION', 'SUBTRACT', 'INTERSECT'], // Optional
  hint: 'Apply a CSG operation', // Optional
}
```

### file
- Required: `type: 'file'`, `label`
- Optional: `hint`, `accept`
- Behavior: hidden `<input type="file">` paired with a trigger button; selected file is stored as a data URL. `accept` is forwarded to the file input.
- Example:
```js
texture: {
  type: 'file',
  label: 'Pick image…',
  accept: '.png,image/png', // Optional
  hint: 'PNG files only', // Optional
}
```

### button
- Required: `type: 'button'`, `label`
- Optional: `hint`, `actionFunction(ctx)`
- Behavior: no value is stored; clicking runs `actionFunction` (receives `{ featureID, key, viewer, partHistory, feature, params, schemaDef }`) or falls back to `onAction` supplied to `SchemaForm`.
- Example:
```js
preview: {
  type: 'button',
  label: 'Preview',
  hint: 'Run without saving', // Optional
  actionFunction: ({ feature }) => feature?.rerun?.(), // Optional
}
```

### component_selector
- Required: `type: 'component_selector'`, `label`
- Optional: `hint`, `buttonLabel`, `dialogTitle`, `onSelect(ctx, record)`
- Behavior: opens the component library modal and writes the chosen component name into the param; `onSelect` can stash extra payload (see `AssemblyComponentFeature`).
- Example:
```js
componentName: {
  type: 'component_selector',
  label: 'Component',
  buttonLabel: 'Select…', // Optional
  dialogTitle: 'Select Component', // Optional
  onSelect: (ctx, record) => handleSelection(ctx, record), // Optional
  hint: 'Pull from component library', // Optional
}
```

### fallback
- Any unknown `type` (or omitted `type`) renders a plain text input via `renderDefaultField`. Use this for quick string fields or to prototype a custom widget before registering one.
