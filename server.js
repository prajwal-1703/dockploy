import express from "express";
import Docker from "dockerode";
import { isNativeError } from "util/types";

import httpProxy from 'http-proxy';
import path from "path";

const docker = new Docker();

function pullImagePromisified(image, tag) {
    return new Promise((res, rej) => {
        docker.pull(`${image}:${tag}`, (err, stream) => {
            if (err) {
                rej(err);
            } else {
                docker.modem.followProgress(stream, (err, output) => {
                    if (err) {
                        rej(err);
                    } else {
                        res(true);
                    }
                });
            }
        });
    });
}


const managementApp = express();

const proxyApp = express();

const proxy = httpProxy.createProxy();


managementApp.use(express.json());

managementApp.use(express.static(path.resolve("./public")));


const MANAGEMENT_API_PORT = process.env.MANAGEMENT_API_PORT ?? 8080;
const PROXY_PORT = process.env.PROXY_PORT ?? 8081;
const REVERSE_PROXY_HOST = process.env.REVERSE_PROXY_HOST ?? '100.93.190.2.nip.io:8081';
managementApp.get('/', (req, res) => {
    return res.json({ status: 'Management APIs are up and running' });
});
managementApp.post('/container', async (req, res) => {
    const { image, tag, port, hostPort, env, cmd, volumes, restartPolicy, autoRemove } = req.body;
    const targetPort = port ? String(port) : '80';
    console.log(`[API] Request to start container: ${image}:${tag} on port ${targetPort} mapped to host port ${hostPort || 'None'}`);
    
    let envArray = [];
    if (env) {
        if (typeof env === 'string') {
            envArray = env.split('\n')
                .map(line => line.trim())
                .filter(line => line && line.includes('='));
        } else if (Array.isArray(env)) {
            envArray = env;
        }
    }

    let cmdArray = undefined;
    if (cmd && cmd.trim()) {
        const trimmed = cmd.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                cmdArray = JSON.parse(trimmed);
            } catch (e) {
                cmdArray = trimmed.split(/\s+/);
            }
        } else {
            cmdArray = trimmed.split(/\s+/);
        }
    }

    let bindsArray = [];
    if (volumes) {
        if (typeof volumes === 'string') {
            bindsArray = volumes.split('\n')
                .map(line => line.trim())
                .filter(line => line && line.includes(':'));
        } else if (Array.isArray(volumes)) {
            bindsArray = volumes;
        }
    }

    const systemImages = await docker.listImages();
    let isExistingImage = false;
    for (const systemImage of systemImages) {
        const repoTags = systemImage.RepoTags || [];
        if (repoTags.includes(`${image}:${tag}`)) {
            isExistingImage = true;
            break;
        }
    }

    if (!isExistingImage) {
        console.log(`[API] Image ${image}:${tag} not found locally. Pulling image...`);
        await pullImagePromisified(image, tag);
        console.log(`[API] Image ${image}:${tag} pulled successfully.`);
    } else {
        console.log(`[API] Image ${image}:${tag} already exists locally.`);
    }

    console.log(`[API] Creating container for ${image}:${tag}...`);
    
    const isAutoRemove = autoRemove !== undefined ? (autoRemove === true || autoRemove === 'true') : true;
    const finalAutoRemove = restartPolicy && restartPolicy !== 'no' ? false : isAutoRemove;

    const hostConfig = {
        AutoRemove: finalAutoRemove,
    };

    if (restartPolicy && restartPolicy !== 'no') {
        hostConfig.RestartPolicy = {
            Name: restartPolicy,
            MaximumRetryCount: 0
        };
    }

    if (bindsArray.length > 0) {
        hostConfig.Binds = bindsArray;
    }

    const createOptions = {
        Image: `${image}:${tag}`,
        Env: envArray,
        Cmd: cmdArray,
        Labels: {
            'dockploy.managed': 'true',
            'dockploy.port': targetPort,
            'dockploy.hostPort': hostPort ? String(hostPort) : ''
        },
        HostConfig: hostConfig,
        NetworkingConfig: {
            EndpointsConfig: {
                'deploy-engine-network': {}
            }
        }
    };

    if (hostPort) {
        createOptions.ExposedPorts = {
            [`${targetPort}/tcp`]: {}
        };
        hostConfig.PortBindings = {
            [`${targetPort}/tcp`]: [
                {
                    HostPort: String(hostPort)
                }
            ]
        };
    }

    const container = await docker.createContainer(createOptions);

    console.log(`[API] Starting container ${container.id}...`);

    await container.start();

    const inspect = await container.inspect();
    const rawName = inspect.Name;
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    
    console.log(`[API] Container ${name} started successfully.`);
    
    return res.json({
        status: 'Success',
        Data: {
            containerName: name,
            domain: `http://${name}.${REVERSE_PROXY_HOST}`,
            hostPort: hostPort ? String(hostPort) : null,
            port: targetPort
        },
    });
});


managementApp.get('/containers', async (req, res) => {
    const systemContainers = await docker.listContainers();
    const containerList = [];
    for (const systemContainer of systemContainers) {
        const rawName = systemContainer.Names[0] || '';
        const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
        const isManaged = systemContainer.Labels && systemContainer.Labels['dockploy.managed'] === 'true';
        const port = isManaged ? systemContainer.Labels['dockploy.port'] : null;
        const hostPort = isManaged ? systemContainer.Labels['dockploy.hostPort'] : null;
        containerList.push({
            containerName: name,
            domain: isManaged ? `http://${name}.${REVERSE_PROXY_HOST}` : null,
            port,
            hostPort
        });
    }
    return res.json({
        status: 'Success',
        Data: containerList,
    })
});

managementApp.delete('/container/:name', async (req, res) => {
    const { name } = req.params;
    console.log(`[API] Request to delete container: ${name}`);
    try {
        const container = docker.getContainer(name);
        await container.remove({ force: true });
        console.log(`[API] Container ${name} deleted successfully.`);
        return res.json({
            status: 'Success',
            message: `Container ${name} deleted successfully.`,
        });
    } catch (err) {
        console.error(`[API] Error deleting container ${name}:`, err);
        return res.status(500).json({
            status: 'Error',
            message: err.message || String(err),
        });
    }
});

managementApp.listen(MANAGEMENT_API_PORT, () => {
    console.log(`Management API running on port ${MANAGEMENT_API_PORT}`);
});


// reverse proxy server 

proxyApp.use(async (req, res) =>{
    const containerName = req.hostname.split('.')[0];
    try {
        const container = docker.getContainer(containerName);
        const inspect = await container.inspect();
        const port = (inspect.Config.Labels && inspect.Config.Labels['dockploy.port']) || '80';
        
        return proxy.web(req, res, {
            target: `http://${containerName}:${port}`
        }, (err) => {
            console.error(`[Proxy Error] Error forwarding request to ${containerName}:${port}:`, err.message);
            if (!res.headersSent) {
                res.status(502).send('Bad Gateway - Container might not be running or reachable.');
            }
        });
    } catch (err) {
        console.error(`[Proxy Error] Error looking up container ${containerName}:`, err.message);
        if (!res.headersSent) {
            res.status(404).send('Not Found - Container not found or not running.');
        }
    }
});

proxyApp.listen(PROXY_PORT, ()=>{
    console.log(`Proxy running on port ${PROXY_PORT}`);
});