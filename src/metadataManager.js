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

    getMetadata(targetObjectName){
        // look up the metadata for the given object name
        let metadataForTarget =  this.metadata[targetObjectName] || {};

        // check if there is an atribute called inheritsFrom
        if (metadataForTarget.inheritsFrom) {
            const parentMetadata = this.getMetadata(metadataForTarget.inheritsFrom);
            // merge parent metadata with current metadata, giving precedence to current metadata
            return { ...parentMetadata, ...metadataForTarget };
        }

        return metadataForTarget;
    }

    setMetadata(targetObjectName, keyName, value) {
        // grab the current metadata for the target object, or create a new object if it doesn't exist
        if (!this.metadata[targetObjectName]) {
            this.metadata[targetObjectName] = {};
        }
        this.metadata[targetObjectName][keyName] = value;
    }


    }