// Fixed usage example showing how to properly handle async data loading
import { 
  initializeDataObjectManager, 
  createDataObject, 
  getDataObjectById 
} from '../src/index';

// Example configuration (replace with your actual Supabase credentials)
const supabaseConfig = {
  url: 'https://suajexircjeawgougtdz.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1YWpleGlyY2plYXdnb3VndGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEwMDc1MjcsImV4cCI6MjA1NjU4MzUyN30.gpM-6Lndd8CJ_vxuYbUFNDmLyoR_RHnT4kDwT8vN3aU',
  projectName: 'FootiePredictors'
};

// FIXED VERSION - Proper async handling
async function fixedExample() {
  console.log('=== Fixed Example ===');
  
  // Initialize the manager
  initializeDataObjectManager({
    supabaseConfig,
    errorHandler: {
      onError: (error) => console.error('Error:', error),
      onWarning: (warning) => console.warn('Warning:', warning),
      onInfo: (info) => console.info('Info:', info)
    }
  });

  try {
    // Create data object and wait for it to be ready
    console.log('Creating data object...');
    const dataObject = await createDataObject('groupLeaderboards', {
      viewName: 'group_members',
      canInsert: true,
      canUpdate: true,
      canDelete: false
    });

    if (dataObject) {
      console.log('Data object created successfully!');
      console.log('Is ready:', dataObject.isReady);
      
      // Now the data should be available
      const data = dataObject.getData();
      console.log('Data length:', data.length);
      console.log('Sample data:', data.slice(0, 3));
      
      // You can also access it by ID
      const sameDataObject = getDataObjectById('groupLeaderboards');
      if (sameDataObject) {
        console.log('Retrieved by ID - Data length:', sameDataObject.getData().length);
      }
      
    } else {
      console.log('Failed to create data object');
    }
    
  } catch (error) {
    console.error('Error in example:', error);
  }
}

// Vue.js onMounted example - FIXED VERSION
function vueOnMountedExample() {
  // In Vue.js, you need to make the onMounted callback async
  // onMounted(async () => {
  //   const supabaseUrl = 'https://suajexircjeawgougtdz.supabase.co'
  //   const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1YWpleGlyY2plYXdnb3VndGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEwMDc1MjcsImV4cCI6MjA1NjU4MzUyN30.gpM-6Lndd8CJ_vxuYbUFNDmLyoR_RHnT4kDwT8vN3aU'
  //
  //   const dbSupabaseConfig = {
  //     url: supabaseUrl,
  //     anonKey: supabaseAnonKey,
  //     projectName: 'FootiePredictors'
  //   }
  //
  //   initializeDataObjectManager({
  //     supabaseConfig: dbSupabaseConfig,
  //     errorHandler: {
  //       onError: (error) => console.error(error),
  //       onWarning: (warning) => console.warn(warning),
  //       onInfo: (info) => console.info(info)
  //     }
  //   });
  //   
  //   // IMPORTANT: await the createDataObject call
  //   const dataObject = await createDataObject('groupLeaderboards', {
  //     viewName: 'group_members',
  //     canInsert: true,
  //     canUpdate: true,
  //     canDelete: false
  //   });
  //
  //   // Now the data will be available
  //   if (dataObject) {
  //     const data = dataObject.getData();
  //     console.log('Data loaded:', data);
  //   }
  // });
}

// Alternative approach - using the waitForReady method
async function alternativeApproach() {
  console.log('=== Alternative Approach ===');
  
  initializeDataObjectManager({
    supabaseConfig,
    errorHandler: {
      onError: (error) => console.error('Error:', error),
      onWarning: (warning) => console.warn('Warning:', warning),
      onInfo: (info) => console.info('Info:', info)
    }
  });

  // Create the data object (this returns immediately but data might not be loaded yet)
  const dataObject = await createDataObject('alternativeExample', {
    viewName: 'group_members',
    canInsert: true,
    canUpdate: true,
    canDelete: false
  });

  if (dataObject) {
    // Check if it's ready
    console.log('Is ready immediately:', dataObject.isReady);
    
    // Wait for it to be ready if it's not
    if (!dataObject.isReady) {
      console.log('Waiting for data to load...');
      await dataObject.waitForReady();
    }
    
    console.log('Is ready after waiting:', dataObject.isReady);
    const data = dataObject.getData();
    console.log('Data length:', data.length);
  }
}

// Reactive data example
async function reactiveDataExample() {
  console.log('=== Reactive Data Example ===');
  
  initializeDataObjectManager({
    supabaseConfig,
    errorHandler: {
      onError: (error) => console.error('Error:', error),
      onWarning: (warning) => console.warn('Warning:', warning),
      onInfo: (info) => console.info('Info:', info)
    }
  });

  const dataObject = await createDataObject('reactiveExample', {
    viewName: 'group_members',
    canInsert: true,
    canUpdate: true,
    canDelete: false
  });

  if (dataObject) {
    // Set up reactive listener
    const unsubscribe = dataObject.onDataChanged((data) => {
      console.log('Data changed! New length:', data.length);
    });

    console.log('Initial data length:', dataObject.getData().length);
    
    // Simulate data refresh
    setTimeout(async () => {
      console.log('Refreshing data...');
      await dataObject.refresh();
    }, 2000);

    // Clean up after 5 seconds
    setTimeout(() => {
      unsubscribe();
      console.log('Unsubscribed from data changes');
    }, 5000);
  }
}

// Export examples
export {
  fixedExample,
  vueOnMountedExample,
  alternativeApproach,
  reactiveDataExample
};

// Uncomment to run examples
// fixedExample();
// alternativeApproach();
// reactiveDataExample();
