# Supabase DataObject Core

A TypeScript library for creating reactive data objects from Supabase tables and views. This package provides a clean, type-safe way to interact with your Supabase data with built-in reactivity, CRUD operations, and advanced querying capabilities.

## Features

- 🔄 **Reactive Data Objects**: Automatically update when data changes
- 🛡️ **Type Safety**: Full TypeScript support with proper type definitions
- 🔍 **Advanced Querying**: Support for filtering, sorting, field selection, and pagination
- ✅ **CRUD Operations**: Built-in Create, Read, Update, Delete functionality
- 🎯 **Named Objects**: Create named data objects that can be accessed globally
- 🔧 **Configurable**: Flexible configuration options for different use cases
- 📦 **Zero Dependencies**: Only depends on @supabase/supabase-js

## Installation

```bash
npm install supabase-dataobject-core
```

## Quick Start

### Basic Usage

```typescript
import { 
  initializeDataObjectManager, 
  createDataObject, 
  getDataObjectById 
} from 'supabase-dataobject-core';

// Initialize the manager with your Supabase config
initializeDataObjectManager({
  supabaseConfig: {
    url: 'https://your-project.supabase.co',
    anonKey: 'your-anon-key'
  }
});

// Create a data object
const userDataObject = await createDataObject('users', {
  viewName: 'users',
  canInsert: true,
  canUpdate: true,
  canDelete: false
});

// Listen for data changes
userDataObject?.onDataChanged((users) => {
  console.log('Users updated:', users);
});

// Access the data object from anywhere
const users = getDataObjectById('users');
if (users) {
  const data = users.getData();
  console.log('Current users:', data);
}
```

### Advanced Configuration

```typescript
import { createDataObject } from 'supabase-dataobject-core';

const ordersDataObject = await createDataObject('pendingOrders', {
  viewName: 'orders',
  fields: [
    { name: 'id', type: 'number' },
    { name: 'customer_name', type: 'string' },
    { name: 'total_amount', type: 'number' },
    { name: 'status', type: 'string' }
  ],
  whereClauses: [
    { field: 'status', operator: 'equals', value: 'pending' },
    { field: 'total_amount', operator: 'greaterthan', value: 100 }
  ],
  sort: { field: 'created_at', direction: 'desc' },
  recordLimit: 50,
  canInsert: true,
  canUpdate: true,
  canDelete: true
});
```

## API Reference

### Core Functions

#### `initializeDataObjectManager(config)`
Initialize the global data object manager.

```typescript
initializeDataObjectManager({
  supabaseConfig: {
    url: 'https://your-project.supabase.co',
    anonKey: 'your-anon-key'
  },
  errorHandler: {
    onError: (error) => console.error(error),
    onWarning: (warning) => console.warn(warning),
    onInfo: (info) => console.info(info)
  }
});
```

#### `createDataObject(name, options)`
Create a new named data object.

```typescript
const dataObject = await createDataObject('myData', {
  viewName: 'table_name',
  // ... other options
});
```

#### `getDataObjectById(id)`
Retrieve a data object by its name/ID.

```typescript
const dataObject = getDataObjectById('myData');
```

#### `getAllDataObjects()`
Get all created data objects.

```typescript
const allObjects = getAllDataObjects();
```

#### `removeDataObject(id)`
Remove a data object by its name/ID.

```typescript
const removed = removeDataObject('myData');
```

#### `refreshDataObject(id)`
Refresh a data object's data from Supabase.

```typescript
await refreshDataObject('myData');
```

### DataObject Class

#### Methods

- `getData()`: Get current data as an array
- `refresh()`: Manually refresh data from Supabase
- `insert(record)`: Insert a new record
- `update(id, updates)`: Update an existing record
- `delete(id)`: Delete a record
- `dispose()`: Clean up the data object
- `onDataChanged(callback)`: Listen for data changes

#### Example

```typescript
const dataObject = getDataObjectById('users');

if (dataObject) {
  // Get current data
  const users = dataObject.getData();
  
  // Insert new user
  await dataObject.insert({
    name: 'John Doe',
    email: 'john@example.com'
  });
  
  // Update user
  await dataObject.update(1, { name: 'Jane Doe' });
  
  // Delete user
  await dataObject.delete(1);
  
  // Listen for changes
  const unsubscribe = dataObject.onDataChanged((data) => {
    console.log('Data updated:', data);
  });
  
  // Clean up listener
  unsubscribe();
}
```

## Configuration Options

### DataObjectOptions

```typescript
interface DataObjectOptions {
  viewName: string;                    // Table or view name
  fields?: DataObjectField[];          // Specific fields to select
  whereClauses?: WhereClause[];        // Filter conditions
  sort?: SortConfig;                   // Sorting configuration
  recordLimit?: number;                // Maximum records to fetch
  canInsert?: boolean;                 // Allow insert operations
  canUpdate?: boolean;                 // Allow update operations
  canDelete?: boolean;                 // Allow delete operations
}
```

### WhereClause

```typescript
interface WhereClause {
  field: string;
  operator: 'equals' | 'notequals' | 'greaterthan' | 'lessthan';
  value: any;
}
```

### SortConfig

```typescript
interface SortConfig {
  field: string;
  direction: 'asc' | 'desc';
}
```

## Error Handling

You can provide custom error handlers when initializing the manager:

```typescript
initializeDataObjectManager({
  supabaseConfig: { /* ... */ },
  errorHandler: {
    onError: (error) => {
      // Handle errors (e.g., show toast notification)
      console.error('DataObject Error:', error);
    },
    onWarning: (warning) => {
      // Handle warnings
      console.warn('DataObject Warning:', warning);
    },
    onInfo: (info) => {
      // Handle info messages
      console.info('DataObject Info:', info);
    }
  }
});
```

## TypeScript Support

This package is written in TypeScript and provides full type safety:

```typescript
import type { 
  DataObjectOptions, 
  DataObjectRecord, 
  SupabaseConfig 
} from 'supabase-dataobject-core';

// Your data will be properly typed
const users: DataObjectRecord[] = dataObject.getData();
```

## Examples

### Service Class Pattern

```typescript
class UserService {
  private getUserDataObject() {
    return getDataObjectById('users');
  }

  async getAllUsers() {
    const dataObject = this.getUserDataObject();
    return dataObject ? dataObject.getData() : [];
  }

  async createUser(userData: any) {
    const dataObject = this.getUserDataObject();
    return dataObject ? await dataObject.insert(userData) : false;
  }

  async updateUser(id: number, updates: any) {
    const dataObject = this.getUserDataObject();
    return dataObject ? await dataObject.update(id, updates) : false;
  }
}
```

### React Hook Pattern

```typescript
import { useEffect, useState } from 'react';
import { getDataObjectById } from 'supabase-dataobject-core';

function useDataObject(id: string) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const dataObject = getDataObjectById(id);
    if (dataObject) {
      setData(dataObject.getData());
      setLoading(false);

      const unsubscribe = dataObject.onDataChanged((newData) => {
        setData(newData);
      });

      return unsubscribe;
    }
  }, [id]);

  return { data, loading };
}
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
