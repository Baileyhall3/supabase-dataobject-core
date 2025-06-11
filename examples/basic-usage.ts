// Basic usage example for supabase-dataobject-core
import { 
  initializeDataObjectManager, 
  createDataObject, 
  getDataObjectById,
  getAllDataObjects,
  DataObjectOptions 
} from '../src/index';

// Example configuration
const supabaseConfig = {
  url: 'https://your-project.supabase.co',
  anonKey: 'your-anon-key'
};

// Initialize the manager
async function initializeExample() {
  // Initialize with configuration
  initializeDataObjectManager({
    supabaseConfig,
    errorHandler: {
      onError: (error) => console.error('Error:', error),
      onWarning: (warning) => console.warn('Warning:', warning),
      onInfo: (info) => console.info('Info:', info)
    }
  });

  console.log('DataObjectManager initialized!');
}

// Create data objects
async function createDataObjectsExample() {
  // Create a users data object
  const usersOptions: DataObjectOptions = {
    viewName: 'users',
    fields: [
      { name: 'id', type: 'number' },
      { name: 'email', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'created_at', type: 'Date' }
    ],
    sort: { field: 'created_at', direction: 'desc' },
    recordLimit: 100,
    canInsert: true,
    canUpdate: true,
    canDelete: false
  };

  const userDataObject = await createDataObject('users', usersOptions);
  
  if (userDataObject) {
    console.log('Users data object created!');
    
    // Listen for data changes
    userDataObject.onDataChanged((users) => {
      console.log(`Users data updated: ${users.length} users`);
    });
  }

  // Create an orders data object with filtering
  const ordersOptions: DataObjectOptions = {
    viewName: 'orders',
    whereClauses: [
      { field: 'status', operator: 'equals', value: 'pending' }
    ],
    sort: { field: 'created_at', direction: 'desc' },
    recordLimit: 50,
    canInsert: true,
    canUpdate: true,
    canDelete: true
  };

  const ordersDataObject = await createDataObject('pendingOrders', ordersOptions);
  
  if (ordersDataObject) {
    console.log('Orders data object created!');
  }
}

// Access data objects from anywhere
function accessDataObjectsExample() {
  // Get users data object
  const usersDataObject = getDataObjectById('users');
  
  if (usersDataObject) {
    const users = usersDataObject.getData();
    console.log('Current users:', users);
    
    // Perform CRUD operations
    usersDataObject.insert({
      email: 'john@example.com',
      name: 'John Doe'
    }).then(success => {
      if (success) {
        console.log('User inserted successfully!');
      }
    });
  }

  // Get orders data object
  const ordersDataObject = getDataObjectById('pendingOrders');
  
  if (ordersDataObject) {
    const orders = ordersDataObject.getData();
    console.log('Pending orders:', orders);
  }

  // List all data objects
  const allDataObjects = getAllDataObjects();
  console.log('All data objects:', allDataObjects.map(obj => obj.name));
}

// Service class example
class UserService {
  private getUserDataObject() {
    return getDataObjectById('users');
  }

  async getAllUsers() {
    const dataObject = this.getUserDataObject();
    return dataObject ? dataObject.getData() : [];
  }

  async createUser(userData: { email: string; name: string }) {
    const dataObject = this.getUserDataObject();
    if (dataObject) {
      return await dataObject.insert(userData);
    }
    return false;
  }

  async updateUser(id: number, updates: Partial<{ email: string; name: string }>) {
    const dataObject = this.getUserDataObject();
    if (dataObject) {
      return await dataObject.update(id, updates);
    }
    return false;
  }

  async refreshUsers() {
    const dataObject = this.getUserDataObject();
    if (dataObject) {
      await dataObject.refresh();
    }
  }

  onUsersChanged(callback: (users: any[]) => void) {
    const dataObject = this.getUserDataObject();
    if (dataObject) {
      return dataObject.onDataChanged(callback);
    }
    return () => {}; // No-op dispose function
  }
}

// Run the example
async function runExample() {
  try {
    console.log('=== Supabase DataObject Core Example ===');
    
    // Initialize
    await initializeExample();
    
    // Create data objects
    await createDataObjectsExample();
    
    // Access data objects
    accessDataObjectsExample();
    
    // Use service class
    const userService = new UserService();
    const users = await userService.getAllUsers();
    console.log('Users from service:', users);
    
    // Listen for user changes
    const unsubscribe = userService.onUsersChanged((users) => {
      console.log('Users changed via service:', users.length);
    });
    
    // Create a user via service
    await userService.createUser({
      email: 'jane@example.com',
      name: 'Jane Smith'
    });
    
    console.log('=== Example completed ===');
    
  } catch (error) {
    console.error('Example failed:', error);
  }
}

// Export for use
export {
  initializeExample,
  createDataObjectsExample,
  accessDataObjectsExample,
  UserService,
  runExample
};

// Uncomment to run the example
// runExample();
