import { MongoClient } from 'mongodb';
import Crawler from 'crawler';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import xmlParser from 'fast-xml-parser';
import { SingleBar } from 'cli-progress';
import { URL } from 'url';

// Load config from .env
dotenv.config();

let urlCounter = 0; // Used to show progress in CLI
const urlCountMax = 20000; // Max urls to store until cache reset

// Create a new progress bar instance
const bar1 = new SingleBar({}, {
  format: ' {bar} {percentage}% | {value}/{total}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591'
});

// Connection URL
const url = process.env.MONGODB_URI;
const client = new MongoClient(url);

// Database Name
const dbName = 'yt-indexer';
const crawledURIs = []; // In memory cache of crawled URIs

// Generates a psuedo-random b64 char
const baseAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function randomChar() {
  return baseAlphabet[crypto.randomInt(0, 64)];
}

// Generates a psuedo-random video ID
function randomVideoId() {
  const vidId = [
    randomChar(), randomChar(), randomChar(), randomChar(),
    randomChar(), randomChar(), randomChar(), randomChar(),
    randomChar(), randomChar(), randomChar(),
  ];
  return vidId.join('');
}

// Puts a uri into crawl que and cache
function crawlURI(crawler, uri, priority = 5) {
  if (crawledURIs.indexOf(uri) === -1) {
    crawledURIs.push(uri);
    crawler.queue(uri, { priority });
  }
}

// Takes a video ID (or generates a random one) and creates an oembed URI that we can use
// to gather public metadata of the video. Then it will insert the URI into the crawler que
function crawlYTVideo(crawler, id) {
  // We use oembed here so that random video check requests dont effect our API rate limits if used
  const url = `https://www.youtube.com/oembed?url=http://www.youtube.com/watch?v=${id || randomVideoId()}&format=json`;
  crawlURI(crawler, url, id && 1);

  if (!id) {
    setTimeout(() => {
      crawlYTVideo(crawler);
    }, 50);
  }
}

async function crawlRandomSearch(crawler) {
  const randomQueryString = randomChar() + randomChar() + randomChar(); // TODO: word dictionary?
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/search?key=${process.env.YT_API_KEY}&maxResults=50&part=snippet&type=video&q=${randomQueryString}`);
  const { items } = res.data;
  for (let i = 0; i < items.length; i++) {
    const { videoId } = items[i].id;
    if (videoId) {
      crawlYTVideo(crawler, videoId);
    }
  }

  setTimeout(() => {
    crawlRandomSearch(crawler);
  }, 50);
}

// Callback for when a page has been crawled
// typically would be omebed JSON or RSS feed
async function onCrawled(error, res, done, opts) {
  urlCounter++;
  if (urlCounter >= urlCountMax) {
    urlCounter = 0;
    crawledURIs = [];
  }
  bar1.update(urlCounter);

  try {
    const { uri } = res.options;
    if (error) {
      console.error(error);
      return;
    }

    console.log(uri);

    if (res.statusCode === 401 || res.body === 'Unauthorized') {
      // Unauthorized means that the video exists but is flagged as not embeddable
      // only way to get info would be through the youtube API - which we can do later
      // so for now lets just store it in the database as a valid uri
      try {
        console.log('\nCrawled unauthed URI:', uri)
        await videosCollection.insertOne({
          uri,
        });
      } catch (e) {
        // Assume dupe key
      }
    } else if (res.statusCode === 200) {
      const { title, author_name, author_url, thumbnail_url } = JSON.parse(res.body);
      const { crawler, videosCollection } = opts;
      console.log('\nCrawled URI:', uri)

      try {
        await videosCollection.insertOne({
          uri,
          title,
          authorName: author_name,
          authorUrl: author_url,
          thumbnail: thumbnail_url,
        });
      } catch (e) {
        // console.error(e);
        // Assume dupe key
      }

      // Get RSS feed of channel and crawl their videos
      const ytChannelStr = 'https://www.youtube.com/channel/';
      if (author_url.substr(0, ytChannelStr.length) === ytChannelStr) {
        const channelId = author_url.substr(ytChannelStr.length);
        const rssUri = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        if (crawledURIs.indexOf(rssUri) === -1) {
          crawledURIs.push(rssUri);
          axios.get(rssUri)
            .then(feedResponse => {
              const { feed } = xmlParser.parse(feedResponse.data, {});
              for (let i = 0; i < feed.entry.length; i++) {
                const feedItem = feed.entry[i];
                if (feedItem && feedItem['yt:videoId']) {
                  crawlYTVideo(crawler, feedItem['yt:videoId']);
                }
              }
            });
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
  done();
}

async function main() {
  // Connect to MongoDB
  await client.connect();
  console.log('Connected successfully to database');

  // Select database and videos collection
  const db = client.db(dbName);
  const collection = db.collection('videos');

  // Ensure DB indices exist
  await collection.createIndex({ uri: 1 }, { unique: true });
  await collection.createIndex({ description: 1 });
  await collection.createIndex({ title: 1 });
  await collection.createIndex({ authorUrl: 1 });
  await collection.createIndex({ authorName: 1 });

  // Crawler object def
  const crawler = new Crawler({
    maxConnections: process.env.MAX_CONNECTIONS || 8,
    rateLimit: process.env.RATE_LIMIT || 50,
    timeout: 5000,
    callback: (error, res, done) => {
      return onCrawled(error, res, done, {
        videosCollection: collection,
        crawler,
      });
    },
    retries: 0,
    jQuery: false,
  });

  // Do some crawling
  console.log('Starting crawling...');
  crawlRandomSearch(crawler);
  crawlYTVideo(crawler);
  // crawlYTVideo(crawler, 'xXjMVS4MYtU'); // Force video to start from

  // Start the progress bar with a total value of 100 and start value of 0
  bar1.start(urlCountMax, 0, {
    speed: 'N/A'
  });
}

main();
