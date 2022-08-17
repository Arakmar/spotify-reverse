import express from 'express'
import querystring from 'querystring'
import he from 'he'
import {MD5} from 'crypto-js';
import 'spotify-api.js';
import { Playlist, Client, CreatePlaylistQuery } from 'spotify-api.js';
import { config } from 'process';

var client_id = '';
var client_secret = '';
var redirect_uri = 'http://localhost:12345/callback';

var generateRandomString = function(length: number) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

function hashCode(str: string): string {
  return MD5(str).toString()
}

var app = express();

async function getMetadataPlaylist(client: Client): Promise<Playlist> {
  let playlists = await client.user.getPlaylists({}, true)
  let metadataPlaylist = playlists.find(element => {
    return element.name === 'reverse_playlist_metadata';
  })

  if (!metadataPlaylist) {
    console.log('Not found reverse_playlist_metadata, creating...')
    const playListData = {
      name: 'reverse_playlist_metadata',
      public: false
    }

    console.log(JSON.stringify(playListData)); 

    metadataPlaylist = await client.user.createPlaylist(playListData) as Playlist
  }

  return new Promise(resolve => { resolve(metadataPlaylist as Playlist) })
}

function getMetadataPlaylistDescription(metadataPlaylist: Playlist): any {
  let metadataDescription: any = {}

  if (metadataPlaylist.description) {
    try {
      metadataDescription = JSON.parse(he.decode(metadataPlaylist.description));
    } catch (error) {
      console.log('Invalid metadata playlist description')
    }
  }

  return metadataDescription
}

async function getPlaylistsToUpdate(client: Client): Promise<Array<Playlist>> {
  let playlists = await client.user.getPlaylists({}, true)
  let metadataPlaylist = await getMetadataPlaylist(client)
  let metadataDescription = await getMetadataPlaylistDescription(metadataPlaylist)

  const list = playlists.filter(function(item: Playlist) {
    try {
      if (!item.description) {
        throw 'No description';
      }
      let description = JSON.parse(he.decode(item.description));

      let reverse_playlist_enabled = description['reverse_playlist_enabled'];
      console.log('JSON detected for ', item.name, item.snapshotID, reverse_playlist_enabled);
      return reverse_playlist_enabled === true
    } catch(e) {
      return false
    }
  });

  let hash = computePlaylistSnapshotHash(list)

  if (metadataDescription['global_hash'] === hash) {
    console.log('global hash matches, skipping sync', hash)
    return []
  } else {
    console.log('Global hash mismatch : ', metadataDescription['global_hash'], hash)
  }

  return list
}

function computePlaylistSnapshotHash(playlists: Array<Playlist>): string {
  let hashObject =  playlists.sort(function(a,b) {return a.id.localeCompare(b.id)}).map(function(x: Playlist) {
    let playListId = x.id
    return x.snapshotID
  })
  return hashCode(hashObject.join(',')).toString()
}

async function updatePlaylistSnapshotHash(client: Client, playlists: Array<Playlist>) {
  let metadataPlaylist = await getMetadataPlaylist(client)
  let metadataDescription = getMetadataPlaylistDescription(metadataPlaylist)
  let hash = computePlaylistSnapshotHash(playlists)

  metadataDescription['global_hash'] = hash
  console.log('Updating global hash to', hash)
  await client.playlists.edit(metadataPlaylist.id, {description: JSON.stringify(metadataDescription)});
}

async function processPlaylist(client: Client, playlist: Playlist) {
  let tracks = []
  for (let offset = 0; offset < playlist.totalTracks; offset += 100) {
    console.log('Retrieving tracks from ', offset, ' to ', offset + 100)
    tracks.push(...await client.playlists.getTracks(playlist.id, {limit: 100, offset}));
  }

  let indexDateTracks = tracks.map((x, index) => { return {index: index, date: new Date(x.addedAt as string), name: x.track?.name}}).sort(function(a,b) {return b.date.getTime() - a.date.getTime()});
  
  
  let found = null
  let lastSnapshot = playlist.snapshotID

  do {
    found = indexDateTracks.findIndex(function (element, index) {
      return index !== element.index;
    });

    if (found !== -1) {
      let foundItem = indexDateTracks[found];
      console.log('Moving from ', foundItem.index, ' to ', found);
      lastSnapshot = await client.playlists.reorderItems(playlist.id, {rangeStart: foundItem.index, insertBefore: found})

      const [temp_item] = tracks.splice(foundItem.index, 1);
      tracks.splice(found, 0, temp_item);
      indexDateTracks = tracks.map((x, index) => { return {index: index, date: new Date(x.addedAt as string), name: x.track?.name}}).sort(function(a,b) {return b.date.getTime() - a.date.getTime()});
    }
  } while (found !== -1)
}

app.get('/', function(req, res) {

  var state = generateRandomString(16);
  var scope = 'user-read-private user-read-email playlist-read-private playlist-modify-private playlist-modify-public';

  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/callback', async function(req, res) {

  var code = req.query.code?.toString();
  var state = req.query.state;

  if (state === null || code === null) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
      return;
  }

  let client = await Client.create({
    userAuthorizedToken: true,
    token: {
        clientID: client_id, // Your spotify application client id.
        clientSecret: client_secret, // Your spotify application client secret.
        code: code,
        redirectURL: redirect_uri
    }
  }).catch(e => { console.log('Client error'); res.redirect('/'); return; })

  if (!client) {
    return;
  }

  console.log('token', client.token)

  const list = await getPlaylistsToUpdate(client)
  
  for (const playlist of list) {
    processPlaylist(client, playlist)
  }

  if (list.length > 0) {
    updatePlaylistSnapshotHash(client, list)
  }

  res.end('ok')
  return;
});

console.log('Listening on 12345');
app.listen(12345);
