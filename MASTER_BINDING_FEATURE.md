# Master Data Object Binding Feature

## Overview

The Master Data Object Binding feature allows you to create relationships between data objects where a child data object automatically filters its data based on the current record of a master data object. When the master data object's current record changes, the child data object automatically refreshes with updated filter criteria.

## How It Works

1. **Master-Child Relationship**: A child data object can be bound to a master data object using the `masterDataObjectBinding` option.

2. **Automatic Filtering**: The child data object automatically adds a where clause that filters records based on the master's current record field value.

3. **Dynamic Updates**: When the master data object's current record changes, the child data object automatically refreshes with the new filter criteria.

4. **Silent Failure**: If the master data object doesn't exist or the binding fields are invalid, the binding setup fails silently without throwing errors.

## Configuration

### MasterDataObjectBinding Interface

```typescript
interface MasterDataObjectBinding {
    masterDataObjectId: string;      // ID of the master data object
    childBindingField: string;       // Field name in child data object for filtering
    masterBindingField: string;      // Field name in master data object to get filter value
}
```

### Usage Example

```typescript
import { DataObjectManager } from './src/dataObjectManager';
import { DataObjectOptions } from './src/types';

// Create master data object (customers)
const masterOptions: DataObjectOptions = {
    viewName: 'customers',
    tableName: 'customers',
    fields: [
        { name: 'id', type: 'number' },
        { name: 'name', type: 'string' },
        { name: 'email', type: 'string' }
    ]
};

const masterDataObject = await manager.createDataObject('customers', masterOptions);

// Create child data object with binding (orders)
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
        masterDataObjectId: 'customers',    // References the master data object
        childBindingField: 'customer_id',   // Child field to filter on
        masterBindingField: 'id'            // Master field to get filter value from
    }
};

const childDataObject = await manager.createDataObject('orders', childOptions);
```

## Implementation Details

### Validation Process

1. **Master Data Object Existence**: Checks if the specified master data object exists in the DataObjectManager.

2. **Field Validation**: Verifies that both the `childBindingField` exists in the child data object's fields and the `masterBindingField` exists in the master data object's fields.

3. **Silent Failure**: If any validation fails, the binding setup fails silently without throwing errors, allowing the data object to be created without the binding.

### Binding Lifecycle

1. **Initialization**: During child data object creation, the binding is set up if all validations pass.

2. **Initial Filter**: A where clause is added to the child data object based on the master's current record.

3. **Change Listener**: A listener is attached to the master data object's `onDataChanged` event.

4. **Dynamic Updates**: When the master data changes, the child's where clause is updated and the child data is refreshed.

5. **Cleanup**: When the child data object is disposed, the change listener is removed.

### Where Clause Management

- The binding automatically adds an `equals` where clause to the child data object.
- If the master's binding field value changes, the old where clause is removed and a new one is added.
- The binding where clause is managed separately from user-defined where clauses.

## Error Handling

The feature implements graceful error handling:

- **Master Not Found**: If the master data object doesn't exist, a warning is logged and the child is created without binding.
- **Field Validation Failure**: If binding fields don't exist, the binding setup fails silently.
- **Runtime Errors**: Any errors during binding setup are caught and logged as warnings.

## Use Cases

### Customer-Orders Relationship
```typescript
// Master: customers table
// Child: orders table filtered by customer_id
masterDataObjectBinding: {
    masterDataObjectId: 'customers',
    childBindingField: 'customer_id',
    masterBindingField: 'id'
}
```

### Category-Products Relationship
```typescript
// Master: categories table
// Child: products table filtered by category_id
masterDataObjectBinding: {
    masterDataObjectId: 'categories',
    childBindingField: 'category_id',
    masterBindingField: 'id'
}
```

### Department-Employees Relationship
```typescript
// Master: departments table
// Child: employees table filtered by department_id
masterDataObjectBinding: {
    masterDataObjectId: 'departments',
    childBindingField: 'department_id',
    masterBindingField: 'id'
}
```

## Best Practices

1. **Create Master First**: Always create the master data object before creating child data objects with bindings.

2. **Field Naming**: Ensure binding field names match exactly between the data objects.

3. **Data Types**: Make sure the binding fields have compatible data types.

4. **Error Handling**: Implement proper error handlers to catch any binding-related warnings or errors.

5. **Memory Management**: Properly dispose of data objects to clean up binding listeners.

## Limitations

1. **Single Master**: A child data object can only be bound to one master data object.

2. **Equals Operator Only**: The binding currently only supports the 'equals' operator for filtering.

3. **Current Record Dependency**: The binding is based on the master's current record, not on record navigation.

4. **No Nested Bindings**: Master-child-grandchild relationships are not directly supported.

## Future Enhancements

Potential improvements for future versions:

1. **Multiple Operators**: Support for other operators like 'in', 'greaterthan', etc.
2. **Multiple Masters**: Allow binding to multiple master data objects.
3. **Nested Bindings**: Support for multi-level master-child relationships.
4. **Custom Binding Logic**: Allow custom functions for binding logic.
5. **Bidirectional Binding**: Support for two-way binding relationships.
