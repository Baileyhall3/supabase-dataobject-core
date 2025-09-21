import { DataObjectManager } from '../src/dataObjectManager';
import { DataObjectOptions, SupabaseConfig } from '../src/types';

// Example configuration - replace with your actual Supabase config
const supabaseConfig: SupabaseConfig = {
    url: 'https://your-project.supabase.co',
    anonKey: 'your-anon-key',
    projectName: 'your-project'
};

// Initialize the DataObjectManager
const manager = DataObjectManager.getInstance({
    supabaseConfig,
    errorHandler: {
        onError: (error) => console.error('Error:', error),
        onWarning: (warning) => console.warn('Warning:', warning),
        onInfo: (info) => console.info('Info:', info)
    }
});

async function demonstrateMasterBinding() {
    try {
        // Create a master data object (e.g., customers)
        const masterOptions: DataObjectOptions = {
            viewName: 'customers',
            tableName: 'customers',
            fields: [
                { name: 'id', type: 'number' },
                { name: 'name', type: 'string' },
                { name: 'email', type: 'string' }
            ],
            canInsert: true,
            canUpdate: true,
            canDelete: true
        };

        console.log('Creating master data object (customers)...');
        const masterDataObject = await manager.createDataObject('customers', masterOptions);
        
        if (!masterDataObject) {
            console.error('Failed to create master data object');
            return;
        }

        console.log('Master data object created successfully');
        console.log('Master data count:', masterDataObject.recordCount);
        console.log('Master current record:', masterDataObject.currentRecord);

        // Create a child data object with binding (e.g., orders)
        const childOptions: DataObjectOptions = {
            viewName: 'orders',
            tableName: 'orders',
            fields: [
                { name: 'id', type: 'number' },
                { name: 'customer_id', type: 'number' },
                { name: 'order_date', type: 'Date' },
                { name: 'total', type: 'number' }
            ],
            masterDataObjectBinding: {
                masterDataObjectId: 'customers',
                childBindingField: 'customer_id',
                masterBindingField: 'id'
            },
            canInsert: true,
            canUpdate: true,
            canDelete: true
        };

        console.log('\nCreating child data object (orders) with master binding...');
        const childDataObject = await manager.createDataObject('orders', childOptions);
        
        if (!childDataObject) {
            console.error('Failed to create child data object');
            return;
        }

        console.log('Child data object created successfully');
        console.log('Child data count:', childDataObject.recordCount);
        console.log('Child current record:', childDataObject.currentRecord);

        // Demonstrate binding behavior
        console.log('\n--- Demonstrating Master-Child Binding ---');
        
        // Listen for changes in child data object
        childDataObject.onDataChanged((data) => {
            console.log('Child data changed! New count:', data.length);
            if (data.length > 0) {
                console.log('First child record:', data[0]);
            }
        });

        // Simulate master data object changes
        console.log('\nSimulating master data object changes...');
        
        // If master has data, try updating it to trigger child refresh
        if (masterDataObject.currentRecord) {
            console.log('Master current record before update:', masterDataObject.currentRecord);
            
            // This would trigger the child to refresh with new binding value
            await masterDataObject.refresh();
            
            console.log('Master refreshed - child should have updated automatically');
        }

        console.log('\n--- Binding Demo Complete ---');
        console.log('The child data object is now bound to the master.');
        console.log('When the master\'s current record changes, the child will automatically');
        console.log('refresh with a new where clause based on the binding fields.');

    } catch (error) {
        console.error('Error in demonstration:', error);
    }
}

// Run the demonstration
demonstrateMasterBinding().then(() => {
    console.log('\nDemo completed successfully!');
}).catch((error) => {
    console.error('Demo failed:', error);
});

export { demonstrateMasterBinding };
