// background.js - Manifest V3 compatible version
let collectedData = []; // Use array for simpler storage
let collectedIds = new Set(); // Track IDs to prevent duplicates
let cropDataStore = {}; // Store crop data separately
let cropRequestBodies = {}; // Store request bodies for crop data
let pendingCropRequests = new Map(); // Track pending crop requests with timestamps
let retryQueue = []; // Queue for retrying failed requests
const MAX_RETRIES = 3; // Maximum number of retries for failed requests
const RETRY_DELAY = 5000; // Delay between retries in milliseconds (5 seconds)

// Add these variables to the top of your background.js file
let autoClickEnabled = false;
let autoClickInterval = null;
const CLICK_DELAY = 1500; // Delay between clicks in milliseconds
let currentTabId = null;

// Define allowed FIPS codes
const ALLOWED_FIPS_CODES = ['06019', '06107', '06029', '06031']; // Fresno, Tulare, Kern, Kings counties

// Initialize the extension when the service worker starts
chrome.runtime.onInstalled.addListener(() => {
  console.log('Acres.com Data Extractor initialized');
  
  // Load any saved data
  loadSavedData();
});

// Listen for completed web requests for property data
chrome.webRequest.onCompleted.addListener(
  function(details) {
    // Filter for GET requests to acres.com with courthouse-comps in the URL
    if (details.method !== "GET" || !details.url.includes('acres.com/courthouse-comps/')) {
      return;
    }
    
    // Fetch the response to get the actual content
    fetch(details.url, {
      credentials: 'include',  // Include cookies for authenticated requests
      headers: {
        'Accept': 'application/json'
      }
    })
    .then(response => {
      if (!response.ok) {
        throw new Error('Network response was not ok: ' + response.status);
      }
      return response.json();
    })
    .then(data => {
      // Check if this has the expected structure and is not a duplicate
      if (data && data.id && !collectedIds.has(data.id)) {
        console.log('Found new property data:', data.id);
        
        // Check if the FIPS code is in our allowed list
        const fipsCode = data.fips_code || '';
        if (!ALLOWED_FIPS_CODES.includes(fipsCode)) {
          console.log('Skipping property with FIPS code:', fipsCode, 'not in allowed list:', ALLOWED_FIPS_CODES);
          return;
        }
        
        console.log('Property has allowed FIPS code:', fipsCode);
        
        // Add this ID to our set of processed IDs to prevent duplicates
        collectedIds.add(data.id);
        
        // Get crop data if we have it - use computed_acres rather than courthouse_acres
        // Prefer computed_acres, fall back to courthouse_acres
        const propertyAcres = data.computed_acres || data.courthouse_acres;
        const cropDataForProperty = findMatchingCropData(propertyAcres);
        
        // Transform to the specific fields requested
        const propertyItem = {
          id: data.id, // Keep ID for reference
          Document_num: data.document_numbers ? data.document_numbers[0] : '',
          County_fipscode: fipsCode,
          Sales_date: data.sale_date || '',
          Sales_amount: data.sale_amount || '',
          Sold_acre: propertyAcres || '',
          price_per_acre: data.price_per_acre_computed || data.price_per_acre_courthouse || '',
          longitude: data.centroid?.coordinates?.[0] || '',
          latitude: data.centroid?.coordinates?.[1] || '',
          // Add crop data if available
          crop1: cropDataForProperty ? cropDataForProperty.crop1 : '',
          crop_ac1: cropDataForProperty ? cropDataForProperty.crop_ac1 : '',
          crop2: cropDataForProperty ? cropDataForProperty.crop2 : '',
          crop_ac2: cropDataForProperty ? cropDataForProperty.crop_ac2 : '',
          crop3: cropDataForProperty ? cropDataForProperty.crop3 : '',
          crop_ac3: cropDataForProperty ? cropDataForProperty.crop_ac3 : ''
        };
        
        // Store the data in our array
        collectedData.push(propertyItem);
        
        // Update the badge to show count of collected items
        chrome.action.setBadgeText({text: collectedData.length.toString()});
        chrome.action.setBadgeBackgroundColor({color: '#4CAF50'});
        
        // Save data to storage
        saveDataToStorage();
        
        console.log('Data added. Total properties:', collectedData.length);
      } else if (data && data.id && collectedIds.has(data.id)) {
        console.log('Skipping duplicate property:', data.id);
      }
    })
    .catch(error => {
      console.error('Error processing property response:', error.message, error.stack);
      // Consider adding retry logic here if needed
    });
  },
  {urls: ["*://*.acres.com/*courthouse-comps/*"]}
);

// Capture and store the request body for crop data requests
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    // Only process POST requests to the crop stats endpoint
    if (details.method !== "POST" || !details.url.includes('acres.com/geoserver/cdl_stats/latest')) {
      return;
    }
    
    // Get the request body
    if (details.requestBody) {
      let requestBodyStr = '';
      
      try {
        if (details.requestBody.raw) {
          // Handle raw binary data
          const decoder = new TextDecoder();
          requestBodyStr = details.requestBody.raw.map(chunk => {
            return chunk.bytes ? decoder.decode(chunk.bytes) : '';
          }).join('');
        } else if (details.requestBody.formData) {
          // Handle form data
          requestBodyStr = JSON.stringify(details.requestBody.formData);
        }
        
        // Try to parse request body to extract acres information
        try {
          const requestBody = JSON.parse(requestBodyStr);
          if (requestBody && requestBody.acres) {
            // Store request with timestamp and acres info
            pendingCropRequests.set(details.requestId, {
              timestamp: Date.now(),
              acres: requestBody.acres,
              retryCount: 0
            });
          }
        } catch (parseError) {
          console.log('Could not parse request body as JSON, storing as string');
        }
        
        // Store with request ID for later use
        cropRequestBodies[details.requestId] = requestBodyStr;
        console.log('Captured crop data request body for ID:', details.requestId);
      } catch (error) {
        console.error('Error capturing request body:', error);
      }
    }
  },
  {urls: ["*://*.acres.com/geoserver/cdl_stats/latest*"]},
  ["requestBody"]
);

// Modified listener for completed crop data requests
chrome.webRequest.onCompleted.addListener(
  function(details) {
    // Only process POST requests to the crop stats endpoint
    if (details.method !== "POST" || !details.url.includes('acres.com/geoserver/cdl_stats/latest')) {
      return;
    }
    
    processCropRequest(details.requestId, details.url);
  },
  {urls: ["*://*.acres.com/geoserver/cdl_stats/latest*"]}
);

// Handle errors in crop data requests
chrome.webRequest.onErrorOccurred.addListener(
  function(details) {
    // Only process POST requests to the crop stats endpoint
    if (details.method !== "POST" || !details.url.includes('acres.com/geoserver/cdl_stats/latest')) {
      return;
    }
    
    console.log(`Error occurred in crop data request: ${details.error} for ID: ${details.requestId}`);
    
    // Check if this is a request we're tracking
    if (pendingCropRequests.has(details.requestId)) {
      const requestInfo = pendingCropRequests.get(details.requestId);
      
      // If we haven't exceeded max retries, add to retry queue
      if (requestInfo.retryCount < MAX_RETRIES) {
        requestInfo.retryCount++;
        pendingCropRequests.set(details.requestId, requestInfo);
        
        // Add to retry queue with delay
        setTimeout(() => {
          console.log(`Retrying crop data request (attempt ${requestInfo.retryCount})`);
          processCropRequest(details.requestId, details.url);
        }, RETRY_DELAY * requestInfo.retryCount);
      } else {
        console.error(`Failed to get crop data after ${MAX_RETRIES} retries for request ID: ${details.requestId}`);
        pendingCropRequests.delete(details.requestId);
        delete cropRequestBodies[details.requestId];
      }
    }
  },
  {urls: ["*://*.acres.com/geoserver/cdl_stats/latest*"]}
);

// Function to process crop data requests (both initial and retries)
function processCropRequest(requestId, url) {
  // Get the stored request body
  const requestBodyStr = cropRequestBodies[requestId];
  if (!requestBodyStr) {
    console.error('No request body found for request ID:', requestId);
    return;
  }
  
  console.log('Processing crop data request for ID:', requestId);
  
  // Make the fetch request with the original body
  fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: requestBodyStr
  })
  .then(response => {
    if (!response.ok) {
      throw new Error('Network response was not ok: ' + response.status);
    }
    return response.json();
  })
  .then(data => {
    // Add extra validation to ensure data has the expected structure
    if (!data) {
      throw new Error('Response data is undefined or null');
    }
    
    if (!data.info) {
      throw new Error('Response data missing info property');
    }
    
    const { info } = data;
    
    if (!info.labels || !info.data || typeof info.acres === 'undefined') {
      throw new Error('Response data missing required properties');
    }
    
    console.log('Successfully fetched crop data, acres:', info.acres);
    
    // Create an array of {name, value} pairs for sorting
    const cropPairs = info.labels.map((label, index) => {
      return {
        name: label,
        value: info.data[index],
        acres: info.data[index] * info.acres
      };
    });
    
    // Sort by value in descending order
    cropPairs.sort((a, b) => b.value - a.value);
    
    // Create a crop data object with the top 3 crops
    const cropDataObject = {
      crop1: cropPairs.length > 0 ? cropPairs[0].name : '',
      crop_ac1: cropPairs.length > 0 ? cropPairs[0].acres.toFixed(2) : '',
      crop2: cropPairs.length > 1 ? cropPairs[1].name : '',
      crop_ac2: cropPairs.length > 1 ? cropPairs[1].acres.toFixed(2) : '',
      crop3: cropPairs.length > 2 ? cropPairs[2].name : '',
      crop_ac3: cropPairs.length > 2 ? cropPairs[2].acres.toFixed(2) : ''
    };
    
    // Store this crop data with the acres as the key
    const acresKey = info.acres.toFixed(2);
    cropDataStore[acresKey] = cropDataObject;
    
    // Update any matching property records
    const updated = updatePropertiesWithCropData(info.acres, cropDataObject);
    if (updated) {
      console.log('Updated properties with crop data for acres:', info.acres);
    } else {
      console.log('No matching properties found for crop data with acres:', info.acres);
      // Store the crop data anyway - it might match a property we see later
    }
    
    // Save data to storage
    saveDataToStorage();
    
    // Clean up stored request data
    pendingCropRequests.delete(requestId);
    delete cropRequestBodies[requestId];
  })
  .catch(error => {
    console.error('Error processing crop data:', error.message, error.stack);
    
    // Check if this is a request we're tracking for retries
    if (pendingCropRequests.has(requestId)) {
      const requestInfo = pendingCropRequests.get(requestId);
      
      // If we haven't exceeded max retries, schedule a retry
      if (requestInfo.retryCount < MAX_RETRIES) {
        requestInfo.retryCount++;
        pendingCropRequests.set(requestId, requestInfo);
        
        // Schedule retry with exponential backoff
        setTimeout(() => {
          console.log(`Retrying crop data request (attempt ${requestInfo.retryCount})`);
          processCropRequest(requestId, url);
        }, RETRY_DELAY * Math.pow(2, requestInfo.retryCount - 1));
      } else {
        console.error(`Failed to get crop data after ${MAX_RETRIES} retries for request ID: ${requestId}`);
        pendingCropRequests.delete(requestId);
        delete cropRequestBodies[requestId];
      }
    } else {
      // Clean up stored request body on error
      delete cropRequestBodies[requestId];
    }
  });
}

// Helper function to update properties with matching crop data
function updatePropertiesWithCropData(cropAcres, cropData) {
  let updated = false;
  
  // Update any property with matching acreage - using more flexible matching
  for (let i = 0; i < collectedData.length; i++) {
    // Try to get acres from the property
    const propertyAcres = collectedData[i].Sold_acre ? 
                          parseFloat(collectedData[i].Sold_acre) : null;
    
    // If property has valid acreage and it matches crop acreage (with slightly more tolerance)
    if (propertyAcres && Math.abs(propertyAcres - cropAcres) < 0.15) {
      console.log('Updating property with crop data, property acres:', propertyAcres, 'crop acres:', cropAcres);
      
      // Update the property with crop data
      collectedData[i] = {
        ...collectedData[i],
        ...cropData
      };
      
      updated = true;
    }
  }
  
  return updated;
}

// Helper function to find matching crop data for a property
function findMatchingCropData(acres) {
  if (!acres) return null;
  
  const acresValue = parseFloat(acres);
  if (isNaN(acresValue)) return null;
  
  // Check all stored crop data for a match with increased tolerance
  for (const [key, value] of Object.entries(cropDataStore)) {
    const cropAcres = parseFloat(key);
    
    // Match within 0.15 acre tolerance (slightly more than before)
    if (Math.abs(acresValue - cropAcres) < 0.15) {
      return value;
    }
  }
  
  return null;
}

// Function to save all data to storage
function saveDataToStorage() {
  chrome.storage.local.set({
    collectedData: collectedData,
    collectedIds: Array.from(collectedIds),
    cropDataStore: cropDataStore
  }, function() {
    console.log('All data saved to storage. Properties:', collectedData.length);
  });
}

// Function to load saved data from storage
function loadSavedData() {
  chrome.storage.local.get(["collectedData", "collectedIds", "cropDataStore"], function(result) {
    if (result.collectedData) {
      collectedData = result.collectedData;
      
      // Restore the collected IDs set
      if (result.collectedIds) {
        collectedIds = new Set(result.collectedIds);
      }
      
      // Restore crop data
      if (result.cropDataStore) {
        cropDataStore = result.cropDataStore;
      }
      
      console.log('Loaded data from storage. Properties:', collectedData.length);
      chrome.action.setBadgeText({text: collectedData.length.toString()});
      chrome.action.setBadgeBackgroundColor({color: '#4CAF50'});
    }
  });
}

// Simplest fixed downloadCSV function for Manifest V3 service worker
function downloadCSV() {
  console.log('Starting CSV download process');
  if (collectedData.length === 0) {
    console.log('No data to download');
    return { status: "error", message: "No data to download" };
  }
  
  try {
    // Set headers in the exact order specified
    const headers = [
      'Document_num', 
      'County_fipscode', 
      'Sales_date', 
      'Sales_amount', 
      'Sold_acre', 
      'price_per_acre', 
      'longitude', 
      'latitude',
      'crop1',
      'crop_ac1',
      'crop2',
      'crop_ac2',
      'crop3',
      'crop_ac3'
    ];
    
    // Create CSV content
    let csvContent = headers.join(',') + '\n';
    
    // Add data rows
    collectedData.forEach(item => {
      const row = headers.map(header => {
        // Escape quotes and wrap fields with commas in quotes
        const value = item[header] === null || item[header] === undefined ? '' : item[header].toString();
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csvContent += row.join(',') + '\n';
    });
    
    // Use URI encoding and data URL scheme - simplest approach
    const dataUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
    
    // Use chrome.downloads API
    chrome.downloads.download({
      url: dataUri,
      filename: 'acres_property_data.csv',
      saveAs: true
    }, function(downloadId) {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError);
        return { status: "error", message: chrome.runtime.lastError.message };
      } else {
        console.log('Download started with ID:', downloadId);
        return { status: "downloading" };
      }
    });
    
    return { status: "downloading" };
  } catch (error) {
    console.error('Error creating CSV download:', error);
    return { status: "error", message: error.message };
  }
}

// Function to be injected into the page for clicking map elements
function clickMapElement() {
  console.log('Attempting to interact with Mapbox map...');
  
  // Wait a moment to ensure the map is fully loaded
  // This can help with detecting markers that might not be immediately available
  function findAndClickMarkers() {
    // First, try to find any map canvas directly
    const mapCanvas = document.querySelector('.mapboxgl-canvas');
    if (!mapCanvas) {
      console.log('No Mapbox canvas found on page');
      return 'No map found';
    }
    
    // Function to find the Mapbox map instance
    function findMapboxInstance() {
      // Look for common Mapbox map instances in global scope
      if (window.map && typeof window.map.getCanvas === 'function') {
        return window.map;
      }
      
      // Look for other common variable names
      const possibleMapNames = ['map', 'mapboxMap', 'mapInstance', 'mapbox', 'mbMap'];
      for (const name of possibleMapNames) {
        if (window[name] && typeof window[name].getCanvas === 'function') {
          return window[name];
        }
      }
      
      // Search for any variable containing a Mapbox map instance
      for (const key in window) {
        try {
          const obj = window[key];
          if (obj && 
              typeof obj === 'object' && 
              typeof obj.getCanvas === 'function' && 
              obj._container && 
              obj._container.classList && 
              obj._container.classList.contains('mapboxgl-map')) {
            console.log('Found Mapbox map instance in window variable:', key);
            return obj;
          }
        } catch (e) {
          // Ignore errors when accessing properties
        }
      }
      
      // Try to get the map from the canvas element
      try {
        let mapInstance = null;
        const container = document.querySelector('.mapboxgl-map');
        if (container && container._mapboxgl) {
          mapInstance = container._mapboxgl;
        }
        
        // Another common pattern - map stored in a jQuery data object
        if (container && window.jQuery && window.jQuery(container).data('map')) {
          return window.jQuery(container).data('map');
        }
        
        return mapInstance;
      } catch (e) {
        console.error('Error trying to find map from canvas:', e);
      }
      
      return null;
    }
    
    // Function to search for markers in the DOM with sidebar exclusion
    function findDOMMarkers() {
      // Common marker class names and selectors
      const markerSelectors = [
        '.mapboxgl-marker',
        '.marker',
        '[class*="marker"]',
        '[class*="pin"]',
        '[class*="point"]',
        '[role="button"][style*="position: absolute"]', // Common for markers
        'div[style*="transform:"][style*="position: absolute"]', // Marker positioning pattern
        'img[src*="marker"]',
        'img[src*="pin"]',
        'svg[class*="marker"]',
        'svg[class*="pin"]'
      ];
      
      // Search for all possible markers
      let markers = [];
      markerSelectors.forEach(selector => {
        try {
          const found = document.querySelectorAll(selector);
          if (found && found.length) {
            console.log(`Found ${found.length} elements matching selector: ${selector}`);
            markers = [...markers, ...Array.from(found)];
          }
        } catch (e) {
          console.error(`Error finding markers with selector ${selector}:`, e);
        }
      });
      
      // Filter out elements in the sidebar
      // First identify the sidebar width
      const sidebar = document.querySelector('nav, .sidebar, [class*="sidebar"], [class*="navigation"]');
      let sidebarWidth = 0;
      let sidebarRight = 0;
      
      if (sidebar) {
        const sidebarRect = sidebar.getBoundingClientRect();
        sidebarWidth = sidebarRect.width;
        sidebarRight = sidebarRect.right;
        console.log(`Detected sidebar width: ${sidebarWidth}px, right edge at ${sidebarRight}px`);
      } else {
        // Default sidebar detection - common widths are 60-300px
        const possibleSidebars = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');
        for (const element of possibleSidebars) {
          const rect = element.getBoundingClientRect();
          // Likely a sidebar if it's tall, narrow, and positioned at the edge
          if (rect.height > window.innerHeight * 0.5 && rect.width < 300 && (rect.left === 0 || rect.right === window.innerWidth)) {
            sidebarWidth = rect.width;
            sidebarRight = rect.right;
            console.log(`Detected possible sidebar: ${sidebarWidth}px wide, right edge at ${sidebarRight}px`);
            break;
          }
        }
        
        // If still not found, use a reasonable default
        if (sidebarWidth === 0) {
          sidebarWidth = 150; // Common sidebar width
          sidebarRight = sidebarWidth;
          console.log('Using default sidebar width: 150px');
        }
      }
      
      // Filter out markers that are in the sidebar area or outside the main content area
      const filteredMarkers = markers.filter(marker => {
        const rect = marker.getBoundingClientRect();
        
        // Skip elements that are in the sidebar
        if (rect.left < sidebarRight) {
          console.log(`Skipping element in sidebar area at position ${rect.left},${rect.top}`);
          return false;
        }
        
        // Skip elements that are too small (likely icons, not markers)
        if (rect.width < 5 || rect.height < 5) {
          return false;
        }
        
        // Skip elements that are too large (likely not markers)
        if (rect.width > 100 || rect.height > 100) {
          return false;
        }
        
        // Skip elements that are at the very top (likely header elements)
        if (rect.top < 60) {
          console.log(`Skipping element in header area at position ${rect.left},${rect.top}`);
          return false;
        }
        
        return true;
      });
      
      console.log(`Found ${markers.length} total potential markers, filtered to ${filteredMarkers.length} markers outside sidebar`);
      return filteredMarkers;
    }
    
    // Find the map instance or work with canvas directly
    const mapInstance = findMapboxInstance();
    
    // Try to find markers in the DOM first
    const domMarkers = findDOMMarkers();
    if (domMarkers.length > 0) {
      // Try to find an unclicked marker
      const clickedMarkerIds = JSON.parse(localStorage.getItem('acres_clicked_dom_markers') || '[]');
      
      // Find markers we haven't clicked yet
      const unclickedMarkers = domMarkers.filter(marker => {
        // Create a unique ID for this marker based on position and class
        const rect = marker.getBoundingClientRect();
        const markerId = `${Math.round(rect.left)}-${Math.round(rect.top)}-${marker.className}`;
        return !clickedMarkerIds.includes(markerId);
      });
      
      // If we have unclicked markers, pick one
      let markerToClick = null;
      
      if (unclickedMarkers.length > 0) {
        console.log(`Found ${unclickedMarkers.length} unclicked DOM markers`);
        
        // Prefer markers that appear to be in the center of the screen
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        
        unclickedMarkers.sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          
          const distA = Math.sqrt(
            Math.pow(rectA.left + rectA.width/2 - centerX, 2) + 
            Math.pow(rectA.top + rectA.height/2 - centerY, 2)
          );
          
          const distB = Math.sqrt(
            Math.pow(rectB.left + rectB.width/2 - centerX, 2) + 
            Math.pow(rectB.top + rectB.height/2 - centerY, 2)
          );
          
          return distA - distB;
        });
        
        markerToClick = unclickedMarkers[0];
      } else if (domMarkers.length > 0) {
        // All markers clicked, reset the tracking and pick a random one
        console.log('All DOM markers clicked, resetting tracking');
        localStorage.setItem('acres_clicked_dom_markers', JSON.stringify([]));
        
        // Pick a random marker
        const randomIndex = Math.floor(Math.random() * domMarkers.length);
        markerToClick = domMarkers[randomIndex];
      }
      
      // Click the selected marker
      if (markerToClick) {
        const rect = markerToClick.getBoundingClientRect();
        const markerId = `${Math.round(rect.left)}-${Math.round(rect.top)}-${markerToClick.className}`;
        
        console.log('Clicking DOM marker:', markerId);
        
        // Add to clicked markers
        const clickedMarkerIds = JSON.parse(localStorage.getItem('acres_clicked_dom_markers') || '[]');
        if (!clickedMarkerIds.includes(markerId)) {
          clickedMarkerIds.push(markerId);
          localStorage.setItem('acres_clicked_dom_markers', JSON.stringify(clickedMarkerIds));
        }
        
        // Create and dispatch the click event
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY
        });
        
        markerToClick.dispatchEvent(clickEvent);
        return `Clicked DOM marker at position ${centerX},${centerY}`;
      }
    }
    
    // If we have a map instance, try to find features on the map
    if (mapInstance) {
      console.log('Looking for features on Mapbox map instance');
      
      try {
        // Direct approach to find visible markers through Mapbox API
        let visibleMarkers = [];
        
        // Check if mapInstance has the specified methods or properties
        const hasMarkers = typeof mapInstance._markers === 'object' && 
                          mapInstance._markers && 
                          Array.isArray(mapInstance._markers);
                          
        if (hasMarkers) {
          visibleMarkers = mapInstance._markers;
          console.log(`Found ${visibleMarkers.length} markers directly in map instance`);
        }
        
        // Try different layer names and approaches to find markers
        const layerNames = [
          'marker-layer', 
          'points', 
          'markers',
          'property-markers',
          'sold-properties',
          'properties',
          'poi-markers',
          'symbol-layer',
          'symbols'
        ];
        
        let mapFeatures = [];
        
// Try querying for specific layers first
for (const layerName of layerNames) {
  try {
    if (mapInstance.getLayer && mapInstance.getLayer(layerName)) {
      const layerFeatures = mapInstance.queryRenderedFeatures(undefined, { layers: [layerName] });
      if (layerFeatures && layerFeatures.length > 0) {
        console.log('Found ' + layerFeatures.length + ' features in layer: ' + layerName);
        mapFeatures = layerFeatures;
        break;
      }
    }
  } catch (e) {
    console.log('Error querying layer ' + layerName + ':', e);
  }
}

// If no features found in specific layers, try more generic queries
if (!mapFeatures.length) {
  try {
    // Try to find points
    mapFeatures = mapInstance.queryRenderedFeatures(undefined, { filter: ['==', '$type', 'Point'] });
    console.log('Found point features:', mapFeatures.length);
    
    // If no points, try circles which are commonly used for markers
    if (!mapFeatures.length) {
      mapFeatures = mapInstance.queryRenderedFeatures(undefined, { filter: ['==', '$type', 'Circle'] });
      console.log('Found circle features:', mapFeatures.length);
    }
    
    // Try to find any symbol features (often used for markers)
    if (!mapFeatures.length) {
      mapFeatures = mapInstance.queryRenderedFeatures(undefined, { filter: ['has', 'symbol'] });
      console.log('Found symbol features:', mapFeatures.length);
    }
  } catch (e) {
    console.error('Error querying for specific feature types:', e);
  }
}

// Last resort: get all features and filter them
if (!mapFeatures.length) {
  try {
    mapFeatures = mapInstance.queryRenderedFeatures();
    console.log('Found all features:', mapFeatures.length);
    
    // Filter to likely point features
    const filteredFeatures = mapFeatures.filter(f => 
      (f.geometry && f.geometry.type === 'Point') || 
      (f.properties && (
        f.properties.type === 'marker' || 
        f.properties.type === 'point' ||
        f.properties.marker === true
      ))
    );
    
    if (filteredFeatures.length > 0) {
      console.log('Filtered to point features:', filteredFeatures.length);
      mapFeatures = filteredFeatures;
    }
  } catch (e) {
    console.error('Error getting all features:', e);
  }
}

// Get markers that we've clicked before
let clickedMarkers = [];
try {
  const stored = localStorage.getItem('acres_clicked_markers');
  if (stored) {
    clickedMarkers = JSON.parse(stored);
  }
} catch (e) {
  console.error('Error parsing clicked markers:', e);
  clickedMarkers = [];
  localStorage.setItem('acres_clicked_markers', JSON.stringify([]));
}

// Find an unclicked feature or use a random one if all clicked
let featureToClick = null;

if (mapFeatures.length) {
  // Find unclicked features
  const unclickedFeatures = mapFeatures.filter(feature => {
    if (!feature.geometry || !feature.geometry.coordinates) {
      return false;
    }
    const featureId = JSON.stringify(feature.geometry.coordinates);
    return !clickedMarkers.includes(featureId);
  });
  
  console.log('Unclicked features:', unclickedFeatures.length, 'of', mapFeatures.length);
  
  if (unclickedFeatures.length) {
    // Either pick closest to center, or random
    if (Math.random() < 0.7) { // 70% chance of picking center
      const center = mapInstance.getCenter();
      unclickedFeatures.sort((a, b) => {
        const aCoords = a.geometry.coordinates;
        const bCoords = b.geometry.coordinates;
        
        const aDist = Math.sqrt(
          Math.pow(aCoords[0] - center.lng, 2) + 
          Math.pow(aCoords[1] - center.lat, 2)
        );
        
        const bDist = Math.sqrt(
          Math.pow(bCoords[0] - center.lng, 2) + 
          Math.pow(bCoords[1] - center.lat, 2)
        );
        
        return aDist - bDist;
      });
      
      featureToClick = unclickedFeatures[0];
    } else {
      // Pick random unclicked
      const randomIndex = Math.floor(Math.random() * unclickedFeatures.length);
      featureToClick = unclickedFeatures[randomIndex];
    }
  } else if (mapFeatures.length) {
    // All have been clicked, pick random
    const randomIndex = Math.floor(Math.random() * mapFeatures.length);
    featureToClick = mapFeatures[randomIndex];
    
    // Reset clicked markers occasionally if we've clicked them all
    if (Math.random() < 0.3) { // 30% chance to reset
      console.log('Resetting clicked markers tracking');
      localStorage.setItem('acres_clicked_markers', JSON.stringify([]));
      clickedMarkers = [];
    }
  }
  
  if (featureToClick && featureToClick.geometry && featureToClick.geometry.coordinates) {
    console.log('Clicking feature at:', featureToClick.geometry.coordinates);
    
    // Mark as clicked
    const featureId = JSON.stringify(featureToClick.geometry.coordinates);
    if (!clickedMarkers.includes(featureId)) {
      clickedMarkers.push(featureId);
      localStorage.setItem('acres_clicked_markers', JSON.stringify(clickedMarkers));
    }
    
    // Convert geo coordinates to pixel coordinates and click
    try {
      const pixelCoords = mapInstance.project(featureToClick.geometry.coordinates);
      const canvas = mapInstance.getCanvas();
      const rect = canvas.getBoundingClientRect();
      
      const clientX = rect.left + pixelCoords.x;
      const clientY = rect.top + pixelCoords.y;
      
      console.log('Clicking at pixel position:', pixelCoords.x, pixelCoords.y);
      console.log('Clicking at client position:', clientX, clientY);
      
      // Create and dispatch click event
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: clientX,
        clientY: clientY
      });
      
      canvas.dispatchEvent(clickEvent);
      return 'Clicked on map feature';
    } catch (e) {
      console.error('Error clicking feature:', e);
    }
  }
}

// If we have visible markers from the map instance, try to click one
if (visibleMarkers && visibleMarkers.length > 0) {
  console.log(`Trying to click one of ${visibleMarkers.length} visible markers`);
  
  // Get a random marker
  const randomIndex = Math.floor(Math.random() * visibleMarkers.length);
  const marker = visibleMarkers[randomIndex];
  
  try {
    // Try to get the element and click it
    if (marker.getElement) {
      const element = marker.getElement();
      if (element) {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY
        });
        
        element.dispatchEvent(clickEvent);
        return `Clicked on marker element at ${centerX},${centerY}`;
      }
    }
    
    // Try to get the LngLat and click at that position
    if (marker.getLngLat) {
      const lngLat = marker.getLngLat();
      if (lngLat) {
        const pixelCoords = mapInstance.project(lngLat);
        const canvas = mapInstance.getCanvas();
        const rect = canvas.getBoundingClientRect();
        
        const clientX = rect.left + pixelCoords.x;
        const clientY = rect.top + pixelCoords.y;
        
        const clickEvent = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: clientX,
          clientY: clientY
        });
        
        canvas.dispatchEvent(clickEvent);
        return `Clicked at marker position ${lngLat.lng},${lngLat.lat}`;
      }
    }
  } catch (e) {
    console.error('Error clicking marker:', e);
  }
}
} catch (mapError) {
console.error('Error interacting with map:', mapError);
}
}

// Special case: look for any elements that look like property cards
const propertyCardSelectors = [
'.property-card',
'.property-listing',
'[class*="property"][class*="card"]',
'[class*="listing-card"]',
'[class*="property-item"]',
'a[href*="property"]',
'div[role="button"][class*="property"]'
];

let propertyCards = [];
propertyCardSelectors.forEach(selector => {
try {
const found = document.querySelectorAll(selector);
if (found && found.length) {
  console.log(`Found ${found.length} elements matching property card selector: ${selector}`);
  propertyCards = [...propertyCards, ...Array.from(found)];
}
} catch (e) {
console.error(`Error finding property cards with selector ${selector}:`, e);
}
});

if (propertyCards.length > 0) {
console.log(`Found ${propertyCards.length} property cards, clicking one`);

// Pick a random property card
const randomIndex = Math.floor(Math.random() * propertyCards.length);
const card = propertyCards[randomIndex];

// Click in the center of the card
const rect = card.getBoundingClientRect();
const centerX = rect.left + rect.width / 2;
const centerY = rect.top + rect.height / 2;

const clickEvent = new MouseEvent('click', {
bubbles: true,
cancelable: true,
view: window,
clientX: centerX,
clientY: centerY
});

card.dispatchEvent(clickEvent);
return `Clicked on property card at ${centerX},${centerY}`;
}

// Fallback: direct interaction with canvas if all else fails
console.log('Using fallback direct canvas interaction');
const canvas = document.querySelector('canvas.mapboxgl-canvas');
if (canvas) {
// Get canvas dimensions
const rect = canvas.getBoundingClientRect();

// Click at a somewhat random position, avoiding edges
const x = rect.left + (rect.width * (0.3 + Math.random() * 0.4));
const y = rect.top + (rect.height * (0.3 + Math.random() * 0.4));

console.log('Fallback clicking at', x, y);

// Create and dispatch click event
const clickEvent = new MouseEvent('click', {
bubbles: true,
cancelable: true,
view: window,
clientX: x, 
clientY: y
});

canvas.dispatchEvent(clickEvent);
return 'Clicked directly on map canvas';
}

return 'Could not interact with map';
}

// Wait a short time for the map to stabilize, then try to find and click markers
// This helps especially after map panning or zooming when markers might be loading
return new Promise((resolve) => {
setTimeout(() => {
const result = findAndClickMarkers();
resolve(result);
}, 300); // Small delay to let the map settle
});
}

// Simplified function to focus the map on counties in sequence
function focusMapOnCountiesInOrder() {
  console.log('Focusing map on target counties with simplified function...');
  
  // Target counties coordinates (California Central Valley) in priority order
  const targetAreas = [
    { name: 'Fresno', lng: -119.7726, lat: 36.7468, zoom: 10, fips: '06019' },
    { name: 'Kern', lng: -118.9015, lat: 35.3933, zoom: 10, fips: '06029' },
    { name: 'Tulare', lng: -118.8028, lat: 36.2308, zoom: 9, fips: '06107' },
    { name: 'Kings', lng: -119.8815, lat: 36.0988, zoom: 10, fips: '06031' }
  ];
  
  // Get current county from localStorage or start with Fresno
  let currentCountyIndex = 0;
  try {
    const storedIndex = localStorage.getItem('acres_current_county_index');
    if (storedIndex !== null) {
      currentCountyIndex = parseInt(storedIndex, 10);
      // Make sure it's valid, otherwise reset
      if (isNaN(currentCountyIndex) || currentCountyIndex < 0 || currentCountyIndex >= targetAreas.length) {
        currentCountyIndex = 0;
      }
    }
  } catch (e) {
    console.error('Error getting stored county index:', e);
    currentCountyIndex = 0;
  }
  
  // Get the current target county
  const currentCounty = targetAreas[currentCountyIndex];
  console.log(`Focusing on county ${currentCounty.name} (${currentCountyIndex + 1}/${targetAreas.length})`);
  
  // Update for next time - cycle through counties
  currentCountyIndex = (currentCountyIndex + 1) % targetAreas.length;
  localStorage.setItem('acres_current_county_index', currentCountyIndex.toString());
  
  // Try multiple approaches to move the map
  
  // Approach 1: Use simpler map discovery
  try {
    if (window.map && typeof window.map.setCenter === 'function') {
      window.map.setCenter([currentCounty.lng, currentCounty.lat]);
      window.map.setZoom(currentCounty.zoom);
      console.log('Successfully focused map via window.map');
      return true;
    }
  } catch (e) {
    console.log('Error with window.map approach:', e);
  }
  
  // Approach 2: Find map by canvas
  try {
    const canvas = document.querySelector('.mapboxgl-canvas');
    if (canvas && canvas.parentNode) {
      // Try to find the map instance from the canvas container
      const container = canvas.parentNode;
      
      // Try common map access patterns
      for (const key in container) {
        try {
          const obj = container[key];
          if (obj && typeof obj === 'object' && typeof obj.setCenter === 'function') {
            obj.setCenter([currentCounty.lng, currentCounty.lat]);
            obj.setZoom(currentCounty.zoom);
            console.log('Successfully focused map via canvas container');
            return true;
          }
        } catch (e) {
          // Skip any errors in property access
        }
      }
    }
  } catch (e) {
    console.log('Error with canvas approach:', e);
  }
  
  // Approach 3: Last resort - try to programmatically click the county navigation
  try {
    // Look for county navigation elements
    const navElements = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    const countyElement = navElements.find(el => 
      el.textContent && 
      (el.textContent.includes(currentCounty.name) || 
       el.textContent.toLowerCase().includes(currentCounty.name.toLowerCase()))
    );
    
    if (countyElement) {
      countyElement.click();
      console.log('Clicked on county navigation element');
      return true;
    }
  } catch (e) {
    console.log('Error with navigation click approach:', e);
  }
  
  console.log('Could not focus map with any method');
  return false;
}

// Improved county targeting function
// This will cycle through counties in order: Fresno → Kern → Tulare → Kings
function focusMapOnTargetCounties(tabId) {
chrome.tabs.get(tabId, function(tab) {
if (chrome.runtime.lastError || !tab) {
console.error('Tab no longer exists');
return;
}

chrome.scripting.executeScript({
target: {tabId: tabId},
func: focusMapOnCountiesInOrder
}).then(results => {
const focused = results[0].result;
if (focused) {
console.log('Successfully focused map on target county');
} else {
console.log('Could not focus map');
}
}).catch(error => {
console.error('Error executing focus script:', error);
});
});
}

// Improved auto-click function with better balance of county focusing
function clickNextButton(tabId) {
  // Decrease the chance of refocusing the map to avoid too much focusing
  // Now 15% chance (was 30%) to spend more time clicking markers
  if (Math.random() < 0.15) {
    console.log('Refocusing map on next target county');
    focusMapOnTargetCounties(tabId);
    
    // Give the map a moment to load after focusing before trying to click
    setTimeout(() => {
      tryClickMapElements(tabId);
    }, 1000);
  } else {
    // Directly try to click map elements
    tryClickMapElements(tabId);
  }
}

// Separate function to handle the actual clicking
function tryClickMapElements(tabId) {
// First check if the tab is still valid
chrome.tabs.get(tabId, function(tab) {
if (chrome.runtime.lastError || !tab) {
console.error('Tab no longer exists, stopping auto-click');
stopAutoClick();
return;
}

// Ensure we're still on acres.com
if (!tab.url.includes('acres.com')) {
console.log('No longer on acres.com, stopping auto-click');
stopAutoClick();
return;
}

// Use the scripting API to execute our click function in the page context
chrome.scripting.executeScript({
target: {tabId: tabId},
func: clickMapElement
}).then(results => {
if (!results || results.length === 0) {
console.error('No results from click script execution');
return;
}

const result = results[0].result;

// Handle the promise from clickMapElement
if (result instanceof Promise) {
result.then(clickResult => {
  console.log('Map interaction result:', clickResult);
}).catch(error => {
  console.error('Error in click script promise:', error);
});
} else {
console.log('Map interaction result:', result);
}
}).catch(error => {
console.error('Error executing click script:', error);

// Check if this is a permissions issue
if (error.message && (
  error.message.includes('permission') || 
  error.message.includes('cannot access'))) {
console.log('Permission error, stopping auto-click');
stopAutoClick();
}
});
});
}

// Start the auto-click process
function startAutoClick() {
if (autoClickEnabled) {
console.log('Auto-click already running');
return; // Already running
}

console.log('Starting auto-click process');

// Find the active tab with acres.com
chrome.tabs.query({active: true, url: "*://*.acres.com/*"}, function(tabs) {
if (chrome.runtime.lastError) {
console.error('Error querying tabs:', chrome.runtime.lastError);
return;
}

if (!tabs || tabs.length === 0) {
console.log('No active acres.com tab found');
return;
}

currentTabId = tabs[0].id;
console.log('Starting auto-click on tab:', currentTabId);

// Test permissions first with a simple script
chrome.scripting.executeScript({
target: {tabId: currentTabId},
func: () => document.domain
}).then(() => {
// Permission granted, start clicking
autoClickEnabled = true;

// Start interval to click buttons
autoClickInterval = setInterval(() => {
if (!autoClickEnabled) {
  clearInterval(autoClickInterval);
  return;
}

clickNextButton(currentTabId);
}, CLICK_DELAY);
}).catch(error => {
console.error('Error starting auto-click:', error);
autoClickEnabled = false;
});
});
}

// Stop the auto-click process
function stopAutoClick() {
if (!autoClickEnabled) {
console.log('Auto-click not running');
return; // Not running
}

console.log('Stopping auto-click');
autoClickEnabled = false;

if (autoClickInterval) {
clearInterval(autoClickInterval);
autoClickInterval = null;
}

currentTabId = null;
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener(
function(request, sender, sendResponse) {
try {
if (request.action === "getData") {
sendResponse({data: collectedData || []});
} else if (request.action === "downloadCSV") {
const result = downloadCSV();
sendResponse(result);
} else if (request.action === "clearData") {
collectedData = [];
collectedIds.clear();
cropDataStore = {};
cropRequestBodies = {};
pendingCropRequests.clear();
chrome.storage.local.remove(["collectedData", "collectedIds", "cropDataStore"], function() {
  console.log("Data cleared from storage");
  chrome.action.setBadgeText({text: ""});
  sendResponse({status: "cleared"});
});
return true; // Will call sendResponse asynchronously
} 
// Add these new action handlers
else if (request.action === "startAutoClick") {
startAutoClick();
sendResponse({status: "autoClickStarted"});
} else if (request.action === "stopAutoClick") {
stopAutoClick();
sendResponse({status: "autoClickStopped"});
} else if (request.action === "getAutoClickStatus") {
sendResponse({autoClickEnabled: autoClickEnabled});
}
} catch (error) {
console.error('Error handling message:', error);
sendResponse({error: error.message});
}
}
);

// Listen for tab events to manage auto-clicking
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
// If the current auto-click tab has been updated and is no longer on acres.com
if (autoClickEnabled && currentTabId === tabId && changeInfo.url && !changeInfo.url.includes('acres.com')) {
stopAutoClick();
}
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
// If the current auto-click tab has been closed
if (autoClickEnabled && currentTabId === tabId) {
stopAutoClick();
}
});

// Load any saved data when the extension starts
loadSavedData();