const getContent = function (urlstr, options) {
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
        params = options.params
        delete options.params
        if (params) {
            body = JSON.stringify(params)
            options.headers['Content-Length'] = body.length
        }
        //console.log(options)
        const request = lib.request(options, (response) => {
            // handle http errors
            if (response.statusCode < 200 || response.statusCode > 299) {
                reject(new Error('Failed to load page, status code: ' + response.statusCode));
            }
            // temporary data holder
            const body = [];
            // on every content chunk, push it to the data array
            response.on('data', (chunk) => body.push(chunk));
            // we are done, resolve promise with those joined chunks
            response.on('end', () => resolve(body.join('')));
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
    getContent(`https://api.github.com/repos/${org}/${repo}/issues/${issue}/comments`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `token ${token}`
        },
        params: {
            body: body,
        },
    })
}

//addComment('mumoshu', 'demo-78a64c769a615eb776', '2', 'test comment', process.env.GITHUB_OAUTH_TOKEN)

module.exports.addComment = addComment
