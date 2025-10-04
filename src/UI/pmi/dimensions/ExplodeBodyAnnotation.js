// ViewTransformAnnotation.js
// View-specific solid transforms for PMI mode

import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayDashedLine } from '../annUtils.js';


const inputParamsSchema = {
  annotationID: {
    type: 'string',
    default_value: null,
    hint: 'unique identifier for the view transform',
  },
  targets: {
    type: 'reference_selection',
    multiple: true,
    default_value: [],
    label: 'Target Objects',
    selectionFilter: ['SOLID'],
    hint: 'Choose the solids to reposition in this view',
  },
  referencePoint: {
    type: 'reference_selection',
    multiple: false,
    default_value: undefined,
    label: 'Reference Point',
    selectionFilter: ['VERTEX', 'FACE', 'PLANE'],
    hint: 'Optional point, edge, or face used as the transform origin',
  },
  transform: {
    type: 'transform',
    label: 'Transform',
    hint: 'Translation and rotation applied relative to the reference point',
  },
  showTraceLine: {
    type: 'boolean',
    default_value: true,
    label: 'Show trace lines',
    hint: 'Draw a line from the original position to the transformed position',
  },
};

export class ExplodeBodyAnnotation extends BaseAnnotation {
  static type = 'explodeBody';
  static title = 'Explode Body';
  static featureShortName = 'explodeBody';
  static featureName = 'Explode Body';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    super();
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(renderingContext) {

  }


}

