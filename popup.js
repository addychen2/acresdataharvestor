// popup.js - Updated for Manifest V3
document.addEventListener('DOMContentLoaded', function() {
  const countElement = document.getElementById('count');
  const downloadBtn = document.getElementById('downloadBtn');
  const clearBtn = document.getElementById('clearBtn');
  const startAutoClickBtn = document.getElementById('startAutoClickBtn');
  const stopAutoClickBtn = document.getElementById('stopAutoClickBtn');
  const autoClickStatusElement = document.getElementById('autoClickStatus');
  const testClickBtn = document.getElementById('testClickBtn');
  const resetClickedBtn = document.getElementById('resetClickedBtn');
  const debugInfoElement = document.getElementById('debugInfo');
  
  // Function to add debug messages
  function addDebugMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    debugInfoElement.innerHTML = `<div>[${timestamp}] ${message}</div>` + debugInfoElement.innerHTML;
    
    // Limit number of messages to prevent overflow
    const messages = debugInfoElement.querySelectorAll('div');
    if (messages.length > 10) {
      messages[messages.length - 1].remove();
    }
  }
  
  // Load data and update UI
  function loadData() {
    try {
      chrome.runtime.sendMessage({action: "getData"}, function(response) {
        if (chrome.runtime.lastError) {
          console.error("Error getting data:", chrome.runtime.lastError);
          return;
        }
        
        const data = response && response.data ? response.data : [];
        const count = data.length;
        countElement.textContent = count;
        
        if (count > 0) {
          downloadBtn.disabled = false;
          clearBtn.disabled = false;
          
          // Check for counties collected
          updateCountyStats(data);
        } else {
          downloadBtn.disabled = true;
          clearBtn.disabled = true;
        }
      });
    } catch (error) {
      console.error("Error sending message:", error);
    }
  }
  
  // Add county statistics to the popup
  function updateCountyStats(data) {
    // Check if we already have the stats element
    let statsElement = document.getElementById('countyStats');
    if (!statsElement) {
      // Create a new element if it doesn't exist
      statsElement = document.createElement('div');
      statsElement.id = 'countyStats';
      statsElement.style.fontSize = '12px';
      statsElement.style.margin = '10px 0';
      statsElement.style.padding = '5px';
      statsElement.style.backgroundColor = '#f5f5f5';
      statsElement.style.borderRadius = '4px';
      
      // Insert after the counter
      document.querySelector('.counter').after(statsElement);
    }
    
    // Count properties by county
    const countsByFips = {
      '06019': 0, // Fresno
      '06107': 0, // Tulare
      '06029': 0, // Kern
      '06031': 0  // Kings
    };
    
    // Count properties by FIPS code
    data.forEach(item => {
      if (item.County_fipscode && countsByFips[item.County_fipscode] !== undefined) {
        countsByFips[item.County_fipscode]++;
      }
    });
    
    // Create HTML for stats
    const countyNames = {
      '06019': 'Fresno',
      '06107': 'Tulare',
      '06029': 'Kern',
      '06031': 'Kings'
    };
    
    let statsHTML = '<strong>Properties by County:</strong><br>';
    for (const [fips, count] of Object.entries(countsByFips)) {
      const countyName = countyNames[fips] || fips;
      const color = count > 0 ? '#4CAF50' : '#999';
      statsHTML += `<span style="color: ${color}">• ${countyName}: ${count}</span><br>`;
    }
    
    statsElement.innerHTML = statsHTML;
  }
  
  // Load auto-click status
  function loadAutoClickStatus() {
    try {
      chrome.runtime.sendMessage({action: "getAutoClickStatus"}, function(response) {
        if (chrome.runtime.lastError) {
          console.error("Error getting auto-click status:", chrome.runtime.lastError);
          return;
        }
        
        updateAutoClickUI(response.autoClickEnabled);
      });
    } catch (error) {
      console.error("Error sending message:", error);
    }
  }
  
// Update UI based on auto-click status
function updateAutoClickUI(isEnabled) {
  if (isEnabled) {
    autoClickStatusElement.textContent = "Active";
    autoClickStatusElement.style.color = "#4CAF50";
    startAutoClickBtn.disabled = true;
    stopAutoClickBtn.disabled = false;
  } else {
    autoClickStatusElement.textContent = "Inactive";
    autoClickStatusElement.style.color = "#f44336";
    startAutoClickBtn.disabled = false;
    stopAutoClickBtn.disabled = true;
  }
}

// Load initial data and status
loadData();
loadAutoClickStatus();

// Download button - Fixed version
downloadBtn.addEventListener('click', function() {
  console.log('Download button clicked');
  addDebugMessage('Starting CSV download...');
  
  try {
    chrome.runtime.sendMessage({action: "downloadCSV"}, function(response) {
      if (chrome.runtime.lastError) {
        console.error("Error downloading CSV:", chrome.runtime.lastError);
        addDebugMessage('Error downloading CSV: ' + chrome.runtime.lastError.message);
      } else {
        console.log('Download response:', response);
        if (response && response.status === "downloading") {
          addDebugMessage('Download initiated...');
        } else if (response && response.status === "error") {
          addDebugMessage('Error: ' + (response.message || 'Unknown error'));
        } else {
          addDebugMessage('Download completed');
        }
      }
    });
  } catch (error) {
    console.error("Error sending download message:", error);
    addDebugMessage('Error: ' + error.message);
  }
});

// Clear button
clearBtn.addEventListener('click', function() {
  if (confirm('Are you sure you want to clear all collected data?')) {
    try {
      chrome.runtime.sendMessage({action: "clearData"}, function(response) {
        if (chrome.runtime.lastError) {
          console.error("Error clearing data:", chrome.runtime.lastError);
          return;
        }
        
        countElement.textContent = "0";
        downloadBtn.disabled = true;
        clearBtn.disabled = true;
        addDebugMessage('All data cleared');
      });
    } catch (error) {
      console.error("Error sending clear message:", error);
    }
  }
});

// Start auto-click button
startAutoClickBtn.addEventListener('click', function() {
  try {
    chrome.tabs.query({active: true, url: "*://*.acres.com/*"}, function(tabs) {
      if (tabs.length === 0) {
        addDebugMessage('Error: Please navigate to acres.com first');
        return;
      }
      
      addDebugMessage('Starting auto-click...');
      
      chrome.runtime.sendMessage({action: "startAutoClick"}, function(response) {
        if (chrome.runtime.lastError) {
          addDebugMessage('Error: ' + chrome.runtime.lastError.message);
          return;
        }
        
        updateAutoClickUI(true);
        addDebugMessage('Auto-click started successfully');
      });
    });
  } catch (error) {
    addDebugMessage('Error: ' + error.message);
  }
});

// Stop auto-click button
stopAutoClickBtn.addEventListener('click', function() {
  try {
    addDebugMessage('Stopping auto-click...');
    
    chrome.runtime.sendMessage({action: "stopAutoClick"}, function(response) {
      if (chrome.runtime.lastError) {
        addDebugMessage('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      
      updateAutoClickUI(false);
      addDebugMessage('Auto-click stopped successfully');
    });
  } catch (error) {
    addDebugMessage('Error: ' + error.message);
  }
});

// Test click button (single click attempt)
testClickBtn.addEventListener('click', function() {
  try {
    chrome.tabs.query({active: true, url: "*://*.acres.com/*"}, function(tabs) {
      if (tabs.length === 0) {
        addDebugMessage('Error: Please navigate to acres.com first');
        return;
      }
      
      addDebugMessage('Attempting a single marker click...');
      
      // Using scripting API instead of executeScript
      chrome.scripting.executeScript({
        target: {tabId: tabs[0].id},
        func: function() {
          // This is the same function as clickMapElement but simplified for a one-time use
          console.log('Running test click on Mapbox map');
          
          // Find map canvas first to verify map exists
          const mapCanvas = document.querySelector('.mapboxgl-canvas');
          if (!mapCanvas) {
            console.log('No Mapbox canvas found on page');
            return 'No map found';
          }
          
          // Function to find DOM markers with sidebar exclusion
          const sidebar = document.querySelector('nav, .sidebar, [class*="sidebar"], [class*="navigation"]');
          let sidebarWidth = 0;
          let sidebarRight = 0;
          
          if (sidebar) {
            const sidebarRect = sidebar.getBoundingClientRect();
            sidebarWidth = sidebarRect.width;
            sidebarRight = sidebarRect.right;
          } else {
            sidebarWidth = 150; // Default sidebar width
            sidebarRight = sidebarWidth;
          }
          
          // Search for all possible markers
          const markerSelectors = [
            '.mapboxgl-marker',
            '.marker',
            '[class*="marker"]',
            '[class*="pin"]',
            '[class*="point"]',
            '[role="button"][style*="position: absolute"]',
            'div[style*="transform:"][style*="position: absolute"]'
          ];
          
          let markers = [];
          markerSelectors.forEach(selector => {
            try {
              const found = document.querySelectorAll(selector);
              if (found && found.length) {
                markers = [...markers, ...Array.from(found)];
              }
            } catch (e) {}
          });
          
          // Filter out markers in sidebar
          const filteredMarkers = markers.filter(marker => {
            const rect = marker.getBoundingClientRect();
            return rect.left > sidebarRight && rect.width > 5 && rect.height > 5 && rect.top > 60;
          });
          
          if (filteredMarkers.length > 0) {
            // Click the first marker
            const marker = filteredMarkers[0];
            const rect = marker.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: centerX,
              clientY: centerY
            });
            
            marker.dispatchEvent(clickEvent);
            return `Clicked marker at position ${centerX},${centerY}`;
          }
          
          // If no markers found, try clicking on the map
          const mapInstance = window.map;
          if (mapInstance && typeof mapInstance.getCanvas === 'function') {
            const canvas = mapInstance.getCanvas();
            const rect = canvas.getBoundingClientRect();
            
            // Click near center of map
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: centerX,
              clientY: centerY
            });
            
            canvas.dispatchEvent(clickEvent);
            return 'Clicked center of map';
          }
          
          return 'Could not find any elements to click';
        }
      }).then(results => {
        if (results && results.length > 0) {
          addDebugMessage('Result: ' + results[0].result);
        } else {
          addDebugMessage('No result from test click');
        }
      }).catch(error => {
        addDebugMessage('Error: ' + error.message);
      });
    });
  } catch (error) {
    addDebugMessage('Error: ' + error.message);
  }
});

// Reset clicked markers button
resetClickedBtn.addEventListener('click', function() {
  try {
    chrome.tabs.query({active: true, url: "*://*.acres.com/*"}, function(tabs) {
      if (tabs.length === 0) {
        addDebugMessage('Error: Please navigate to acres.com first');
        return;
      }
      
      addDebugMessage('Resetting clicked markers...');
      
      chrome.scripting.executeScript({
        target: {tabId: tabs[0].id},
        func: function() {
          // Clear both DOM marker tracking and localStorage tracking
          try {
            // Reset map feature markers
            localStorage.removeItem('acres_clicked_markers');
            
            // Reset DOM markers
            localStorage.removeItem('acres_clicked_dom_markers');
            
            // Reset county tracking (optional)
            localStorage.removeItem('acres_current_county_index');
            localStorage.removeItem('acres_county_collection_counts');
            
            return 'Reset all marker and county tracking';
          } catch (e) {
            return 'Error resetting markers: ' + e.message;
          }
        }
      }).then(results => {
        if (results && results.length > 0) {
          addDebugMessage('Result: ' + results[0].result);
        } else {
          addDebugMessage('No result from reset operation');
        }
      }).catch(error => {
        addDebugMessage('Error: ' + error.message);
      });
    });
  } catch (error) {
    addDebugMessage('Error: ' + error.message);
  }
});
});