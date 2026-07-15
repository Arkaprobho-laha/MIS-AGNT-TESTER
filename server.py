import http.server
import urllib.request
import urllib.error
import socketserver
import sys

import os
PORT = int(os.environ.get("PORT", 8099))
TARGET_API = "http://69.62.84.108:8000"

class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Log to stderr
        sys.stderr.write("%s - - [%s] %s\n" %
                         (self.client_address[0],
                          self.log_date_time_string(),
                          format%args))
        sys.stderr.flush()

    def do_GET(self):
        if self.path.startswith('/api/'):
            self.proxy_request('GET')
        elif self.path.startswith('/proxy-image?url='):
            self.proxy_image_request()
        else:
            # FIX: Block direct access to server-side source & config files
            blocked_extensions = ('.py', '.pyc', '.env', '.cfg', '.ini', '.sh', '.bat')
            path_lower = self.path.split('?')[0].lower()
            if any(path_lower.endswith(ext) for ext in blocked_extensions):
                self.send_error(403, 'Forbidden')
                return
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            self.proxy_request('POST')
        else:
            super().do_POST()

    def do_OPTIONS(self):
        if self.path.startswith('/api/') or self.path.startswith('/proxy-image'):
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept')
            self.end_headers()
        else:
            super().do_OPTIONS()

    def proxy_image_request(self):
        from urllib.parse import urlparse, parse_qs
        parsed_path = urlparse(self.path)
        query = parse_qs(parsed_path.query)
        target_url = query.get('url', [None])[0]
        
        if not target_url:
            self.send_error(400, 'Missing url parameter')
            return
            
        try:
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            
            req = urllib.request.Request(target_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10, context=ctx) as response:
                content = response.read()
                
                self.send_response(200)
                self.send_header('Content-Type', response.headers.get('Content-Type', 'image/jpeg'))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                
                self.wfile.write(content)
        except Exception as e:
            print(f"Proxy Image Error: {e}")
            self.send_error(500, f'Image Proxy Error: {str(e)}')

    def proxy_request(self, method):
        url = TARGET_API + self.path
        
        # Read content length for POST requests
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None
        
        # Prepare headers
        headers = {}
        for header, value in self.headers.items():
            if header.lower() not in ('host', 'content-length', 'connection'):
                headers[header] = value

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        
        try:
            with urllib.request.urlopen(req) as response:
                self.send_response(response.status)
                for header, value in response.getheaders():
                    if header.lower() not in ('transfer-encoding', 'content-length'):
                        self.send_header(header, value)
                
                # Copy response body
                res_data = response.read()
                self.send_header('Content-Length', str(len(res_data)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(res_data)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for header, value in e.headers.items():
                if header.lower() not in ('transfer-encoding', 'content-length'):
                    self.send_header(header, value)
            
            res_data = e.read()
            self.send_header('Content-Length', str(len(res_data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(res_data)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(f'{{"error": "{str(e)}"}}'.encode('utf-8'))

# Run server with ThreadingHTTPServer
# Allow re-use of address socket
from http.server import ThreadingHTTPServer

if __name__ == '__main__':
    server_address = ("0.0.0.0", PORT)
    httpd = ThreadingHTTPServer(server_address, ProxyHTTPRequestHandler)
    print(f"Threading Same-Origin Proxy server active at http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutdown proxy server.")
        sys.exit(0)
