import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

// Configuration
const API_URL = process.env.GHOST_API_URL;
const API_KEY = process.env.GHOST_CONTENT_KEY;
const CACHE_FILE = 'geocode-cache.json';
const OUTPUT_FILE = 'locations.json';
const OVERRIDES_FILE = 'manual-overrides.json';

// Load or initialize the geocode cache
let geocodeCache = {};
try {
    if (fs.existsSync(CACHE_FILE)) {
        geocodeCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        console.log(`💾 Loaded ${Object.keys(geocodeCache).length} cached locations.`);
    }
} catch (error) {
    console.warn('⚠️ Could not load cache, starting fresh.');
}


let manualOverrides = {};
try {
    if (fs.existsSync(OVERRIDES_FILE)) {
        manualOverrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
        console.log(`🛠️ Loaded ${Object.keys(manualOverrides).length} manual overrides.`);
    }
} catch (error) {
    console.warn('⚠️ Could not load manual overrides.');
}

// Helper function to make API requests
async function fetchGhostPosts() {
    const url = `${API_URL}/ghost/api/content/posts/?limit=100&include=tags&key=${API_KEY}`;
    const response = await fetch(url);
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ghost API Error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.posts;
}

// --- DETECTION & EXTRACTION LOGIC ---

function detectLocationTag(tags) {
    // Look for tags that match the "Country, City" format
    const locationTag = tags.find(tag => /^[A-Za-zäöüÄÖÜß\s]+,\s*[A-Za-zäöüÄÖÜß\s]+$/.test(tag.name));
    return locationTag ? locationTag.name : null;
}

function detectMapLink(html) {
    if (!html) return null;
    // Regex to find supported map links (OsmAnd, OSM, Apple, Standard Google)
    const mapLinkRegex = /https?:\/\/(osmand\.net|www\.openstreetmap\.org|maps\.apple\.com|maps\.google\.com)[^\s"<>]+/i;
    const match = html.match(mapLinkRegex);
    return match ? match[0] : null;
}

function extractCoordinatesFromLink(url) {
    if (!url) return null;
    let match;

    // 1. OsmAnd: pin=lat,lng OR pin=lat%2Clng (URL-encoded comma)
    match = url.match(/pin=([-\d.]+)(?:%2C|,)([-\d.]+)/i);
    if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };

    // 2. OpenStreetMap: ?mlat=lat&mlon=lng OR ?lat=lat&lon=lng
    match = url.match(/[?&](?:m)?lat=([-\d.]+).*?[?&](?:m)?lon=([-\d.]+)/i);
    if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };

    // 3. OpenStreetMap Hash: #map=zoom/lat/lng
    match = url.match(/#map=\d+\/([-\d.]+)\/([-\d.]+)/i);
    if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };

    // 4. Apple Maps: ?ll=lat,lng
    match = url.match(/[?&]ll=([-\d.]+)(?:%2C|,)([-\d.]+)/i);
    if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };

    // 5. Google Maps (Standard share links only): ?q=lat,lng or /@lat,lng
    match = url.match(/[?&]q=([-\d.]+)(?:%2C|,)([-\d.]+)/i);
    if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
    
    match = url.match(/\/@([-\d.]+)(?:%2C|,)([-\d.]+)/i);
    if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };

    return null;
}

// --- GEOCODING LOGIC WITH CACHE ---

async function geocodeTag(tagName) {
    // 1. Check cache first!
    if (geocodeCache[tagName]) {
        console.log(`   ⚡ Using cached coordinates for: "${tagName}"`);
        return geocodeCache[tagName];
    }

    // 2. Not in cache, fetch from Nominatim
    console.log(`   🌍 Geocoding new tag: "${tagName}"...`);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(tagName)}`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'WanderGhost-Worker/1.0 (Self-hosted travel blog)'
            }
        });
        
        if (!response.ok) return null;
        
        const data = await response.json();
        if (data && data.length > 0) {
            const coords = {
                lat: parseFloat(data[0].lat),
                lng: parseFloat(data[0].lon),
                displayName: data[0].display_name
            };
            
            // 3. Save to cache for next time
            geocodeCache[tagName] = coords;
            return coords;
        }
        return null;
    } catch (error) {
        console.error(`Geocoding error for ${tagName}:`, error.message);
        return null;
    }
}

// --- MAIN EXECUTION ---

async function runWorker() {
    console.log('🚀 WanderGhost Worker starting...');
    
    try {
        const posts = await fetchGhostPosts();
        console.log(`✅ Successfully fetched ${posts.length} posts.`);
        
        const locationsData = [];
        let cacheUpdated = false;

        for (const post of posts) {
            console.log(`\n📄 Processing: "${post.title}" (ID: ${post.id})`);
            if (manualOverrides[post.id]) {
                console.log(`   🛠️ Using manual override for: "${post.title}"`);
                
                locationsData.push({
                    postId: post.id,
                    postTitle: post.title,
                    postUrl: post.url,
                    featureImage: post.feature_image,
                    publishedAt: post.published_at,
                    location: {
                        lat: manualOverrides[post.id].lat,
                        lng: manualOverrides[post.id].lng,
                        label: manualOverrides[post.id].label || 'Manual Override',
                        source: 'manual_override'
                    }
                });
                
                // 'continue' skips the rest of the loop and moves to the next post
                continue; 
            }
            const locationTag = detectLocationTag(post.tags || []);
            const mapLink = detectMapLink(post.html);

            let coordinates = null;
            let source = null;

            // 1. Try Map Link first (instant extraction, no API call)
            if (mapLink) {
                coordinates = extractCoordinatesFromLink(mapLink);
                if (coordinates) source = 'map_link';
            }

            // 2. Fallback to Geocoding the Tag
            if (!coordinates && locationTag) {
                coordinates = await geocodeTag(locationTag);
                if (coordinates) {
                    source = 'tag_geocode';
                    cacheUpdated = true; // Mark that we need to save the cache
                }
                
                // Respect Nominatim rate limit (1 request per second)
                // Only wait if we actually made a network request (not cached)
                if (!geocodeCache[locationTag] || !geocodeCache[locationTag].lat) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // 3. Store if we found coordinates
            if (coordinates) {
                console.log(`   📍 Saved: "${post.title}" via ${source}`);
                
                locationsData.push({
                    postId: post.id,
                    postTitle: post.title,
                    postUrl: post.url,
                    featureImage: post.feature_image,
                    publishedAt: post.published_at,
                    location: {
                        lat: coordinates.lat,
                        lng: coordinates.lng,
                        label: locationTag || 'Map Link',
                        source: source
                    }
                });
            }

            // If we detected a location input but failed to get coordinates, warn the user!
            if (!coordinates && (locationTag || mapLink)) {
                console.warn(`   ⚠️ WARNING: Detected location in "${post.title}" but failed to resolve it!`);
                if (locationTag) console.warn(`      -> Failed Tag: "${locationTag}"`);
                if (mapLink) console.warn(`      -> Failed Link: "${mapLink}"`);
            }
        }
        
        // 4. Save outputs
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(locationsData, null, 2));
        console.log(`\n💾 Saved ${locationsData.length} locations to ${OUTPUT_FILE}.`);
        
        if (cacheUpdated) {
            fs.writeFileSync(CACHE_FILE, JSON.stringify(geocodeCache, null, 2));
            console.log(`💾 Updated geocode cache saved to ${CACHE_FILE}.`);
        }
        
        console.log('🎉 Worker finished successfully.');
        
    } catch (error) {
        console.error('❌ Worker failed:', error.message);
    }
}

runWorker();