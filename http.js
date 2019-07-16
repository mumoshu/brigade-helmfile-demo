const  URL = require('url').URL

const request = function (urlstr, options) {
    // return new pending promise
    return new Promise((resolve, reject) => {
        // select http or https module, depending on reqested url
        const lib = urlstr.startsWith('https') ? require('https') : require('http');
        u = new URL(urlstr)
        //console.log(u)
        options.host = u.hostname
        options.port = u.port
        options.path = u.pathname
        if (!options.port) {
            if (u.protocol.startsWith('https:')) {
                options.port = 443
            } else {
                options.port = 80
            }
        }
        options.headers['User-Agent'] = 'Brigade-Worker'
        params = options.parameters
        delete options.parameters
        if (params) {
            body = JSON.stringify(params)
            options.headers['Content-Length'] = body.length
        }
        console.log('http.request', options)
        const request = lib.request(options, (response) => {
            console.log('http.response', { status: `${response.statusCode}`, headers: JSON.stringify(response.headers) });
            response.setEncoding('utf8');

            // temporary data holder
            const body = [];
            // on every content chunk, push it to the data array
            response.on('data', (chunk) => body.push(chunk));
            // we are done, resolve promise with those joined chunks
            response.on('end', () => {
                // handle http errors
                if (response.statusCode < 200 || response.statusCode > 299) {
                    reject(new Error('Failed to load page, status code: ' + response.statusCode + ': ' + body.join('')));
                } else {
                    resolve(body.join(''))
                }
            })
        });
        // handle connection errors of the request
        request.on('error', (err) => reject(err))
        if (params) {
            request.write(body)
        }
        request.end()
    })
};

function addComment(org, repo, issue, body, token) {
    return request(`https://api.github.com/repos/${org}/${repo}/issues/${issue}/comments`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `token ${token}`
        },
        parameters: {
            body: body,
        },
    })
}

function get(url, token) {
    return request(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `token ${token}`
        }
    })
}
function post(url, params, token) {
    return request(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `token ${token}`
        },
        parameters: params
    })
}

function checkAuth(token) {
    return request(`https://api.github.com`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            "Authorization": `token ${token}`
        }
    })
}

module.exports.addComment = addComment
module.exports.get = get
module.exports.post = post
