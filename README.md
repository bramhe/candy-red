edison-gw
===

## Install on Edison

`npm install -g` is NOT available for installation/uninstalltion since `npm` runs scripts in package.json as a `nobody` user (https://github.com/npm/npm/issues/5596), which makes any provileged operations fail.

Instead, please run the `install.sh`.
Make sure to add `WS_URL` environment variable in order to tell the installer your favorite WebSocket server URL.

```
$ cd package/root # where package.json exists
$ WS_URL=ws://your-websocket-address/and/path ./install.sh
```

This will take a couple of minutes.

You can ignore `npm WARN`s, `gyp WARN`s, `gyp ERR!`s and `node-pre-gyp ERR!`s unless the installation terminates normally. You can check if the installation is successful by `systemctl status gwd` command.

## Stop/Start/Status Service

The edison-gw service name is `gwd`.

```
$ systemctl stop gwd
$ systemctl start gwd
$ systemctl status gwd
```

## Uninstall from Edison

Please run the `preuninstall.sh` manually BEFORE `npm uninstall`.

```
$ /usr/lib/node_modules/edison-gw/services/ssytemd/preuninstall.sh
$ npm uninstall -g edison-gw
```

## Setup for Building

In order to install dependencies for development use.

```
$ npm run setup
```

## Build

```
$ npm run build
```

Please remember to insert `run` between `npm` and `build`.

## Run on localhost for development use

Try the following commands after `npm run build`:
### without auth
```
$ WS_DEBUG=true WS_URL=ws://your-ws-host ./dist/index.js
```

e.g. `WS_DEBUG=true WS_URL=ws://echo.websocket.org ./dist/index.js`

And you'll see the sensor info like this:
```
connecting to ws://echo.websocket.org
ready
WebSocket opened.
Starting Scanning...
Data:{"type":"te","unit":"C","val":23.5,"ts":1444616815322,"rssi":-52,"deviceUuid":"9999999990a93489c9678a35043759999"}
```

### with basic auth
```
$ WS_DEBUG=true WS_URL=ws://your-ws-host WS_USER=foo WS_PASSWORD=bas ./dist/index.js
```

## Test

```
$ npm test
```
or
```
$ npm run test
```

## Package

```
$ npm pack
```
