// test_cylinder_radius_embedding.js
// Test script to verify that cylindrical faces have embedded radius information

import { BREP } from './src/BREP/BREP.js';

async function testCylinderRadiusEmbedding() {
    console.log('=== Testing Cylinder Radius Embedding ===');
    
    try {
        // Create a test cylinder
        const cylinder = new BREP.Cylinder({
            radius: 5.0,
            height: 10.0,
            resolution: 32,
            name: 'TestCylinder'
        });
        
        // Check if the cylindrical face metadata is embedded
        const sideFaceName = 'TestCylinder_S';
        const metadata = cylinder.getFaceMetadata(sideFaceName);
        
        console.log(`Checking metadata for face: ${sideFaceName}`);
        console.log('Face metadata:', metadata);
        
        if (metadata) {
            console.log('✓ Face metadata found!');
            console.log(`  Type: ${metadata.type}`);
            console.log(`  Radius: ${metadata.radius}`);
            console.log(`  Height: ${metadata.height}`);
            console.log(`  Axis: [${metadata.axis.join(', ')}]`);
            console.log(`  Center: [${metadata.center.join(', ')}]`);
            
            // Verify the values match what we set
            if (metadata.type === 'cylindrical' && 
                Math.abs(metadata.radius - 5.0) < 1e-6 &&
                Math.abs(metadata.height - 10.0) < 1e-6) {
                console.log('✓ All metadata values are correct!');
            } else {
                console.log('✗ Metadata values do not match expected values');
            }
        } else {
            console.log('✗ No face metadata found for cylindrical face');
        }
        
        // Test boolean operation preservation
        console.log('\n=== Testing Boolean Operation Metadata Preservation ===');
        
        const cylinder2 = new BREP.Cylinder({
            radius: 3.0,
            height: 12.0,
            resolution: 24,
            name: 'TestCylinder2'
        });
        
        // Perform union operation
        const unionResult = cylinder.union(cylinder2);
        
        // Check if metadata is preserved in union result
        const metadata1 = unionResult.getFaceMetadata('TestCylinder_S');
        const metadata2 = unionResult.getFaceMetadata('TestCylinder2_S');
        
        console.log('Metadata for TestCylinder_S after union:', metadata1);
        console.log('Metadata for TestCylinder2_S after union:', metadata2);
        
        if (metadata1 && metadata2) {
            console.log('✓ Face metadata preserved through boolean operations!');
        } else {
            console.log('✗ Face metadata not preserved through boolean operations');
        }
        
    } catch (error) {
        console.error('Test failed with error:', error);
    }
}

// For testing in Node.js environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = testCylinderRadiusEmbedding;
} else {
    // For browser testing
    window.testCylinderRadiusEmbedding = testCylinderRadiusEmbedding;
}

// Auto-run if executed directly
if (typeof require !== 'undefined' && require.main === module) {
    testCylinderRadiusEmbedding();
}