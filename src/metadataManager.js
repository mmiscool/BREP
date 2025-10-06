// this will be used to store information against items in the scene that could be used to capture things like
// material assignments, layer assignments, grouping information, etc.
// For example if there is a particular type of weld that needs to be applied allong a particular edge, that information
// could be stored here
// This is a simple key/value store, where the key is the name of the object in the scene, and the value is an object
// containing key/value pairs of metadata. There is also support for inheritance, so that if an object has an attribute
// called "inheritsFrom", it will look up the metadata for that object and merge it with its own metadata, giving precedence
// to its own metadata in case of inheritance giving precedence to its own metadata in case of conflicts.


export class MetadataManager {
    constructor() {
        this.metadata = {};
    }

    getMetadata(targetObjectName) {
        // look up the metadata for the given object name
        const metadataForTarget = this.metadata[targetObjectName] || {};

        // check if there is an attribute called inheritsFrom
        if (metadataForTarget.inheritsFrom) {
            const parentMetadata = this.getMetadata(metadataForTarget.inheritsFrom);
            // merge parent metadata with current metadata, giving precedence to current metadata
            return { ...parentMetadata, ...metadataForTarget };
        }

        return metadataForTarget;
    }

    getOwnMetadata(targetObjectName) {
        // shallow clone to avoid exposing internal references
        const raw = this.metadata[targetObjectName];
        return raw ? { ...raw } : {};
    }

    setMetadata(targetObjectName, keyName, value) {
        // grab the current metadata for the target object, or create a new object if it doesn't exist
        if (!this.metadata[targetObjectName]) {
            this.metadata[targetObjectName] = {};
        }
        this.metadata[targetObjectName][keyName] = value;
    }

    setMetadataObject(targetObjectName, metadataObject) {
        if (metadataObject && Object.keys(metadataObject).length > 0) {
            this.metadata[targetObjectName] = { ...metadataObject };
        } else {
            delete this.metadata[targetObjectName];
        }
    }

    deleteMetadataKey(targetObjectName, keyName) {
        const entry = this.metadata[targetObjectName];
        if (!entry) return;
        delete entry[keyName];
        if (Object.keys(entry).length === 0) {
            delete this.metadata[targetObjectName];
        }
    }

    clearMetadata(targetObjectName) {
        delete this.metadata[targetObjectName];
    }
}
