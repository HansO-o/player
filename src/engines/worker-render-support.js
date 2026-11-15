let cachedProbe;

/**
 * API presence does not prove that a transferred OffscreenCanvas has a usable
 * worker WebGL context (notably WebKit ports). Probe the same transfer path the
 * decoder renderer will use, and verify a real clear/readback operation.
 */
export function probeWorkerWebGL() {
  if (cachedProbe) return cachedProbe;
  cachedProbe = new Promise((resolve) => {
    if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function'
      || !HTMLCanvasElement.prototype.transferControlToOffscreen) {
      resolve({ supported: false, webgl2: false, reason: 'offscreen-transfer-unavailable' });
      return;
    }
    const source = `self.onmessage=({data:canvas})=>{
      try {
        const attributes={alpha:true,antialias:false,preserveDrawingBuffer:false};
        let gl=canvas.getContext('webgl2',attributes); const webgl2=!!gl;
        if(!gl)gl=canvas.getContext('webgl',attributes)||canvas.getContext('experimental-webgl',attributes);
        if(!gl){self.postMessage({supported:false,webgl2:false,reason:'worker-webgl-unavailable'});return;}
        gl.viewport(0,0,2,2);gl.clearColor(0.25,0.5,0.75,1);gl.clear(gl.COLOR_BUFFER_BIT);
        const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        const shader=gl.createShader(gl.VERTEX_SHADER);
        if(shader){gl.shaderSource(shader,webgl2?'#version 300 es\\nvoid main(){gl_Position=vec4(0.0,0.0,0.0,1.0);}':'void main(){gl_Position=vec4(0.0,0.0,0.0,1.0);}');gl.compileShader(shader);}
        const supported=!!shader&&gl.getShaderParameter(shader,gl.COMPILE_STATUS)&&gl.getError()===gl.NO_ERROR&&Math.abs(pixel[0]-64)<=2&&Math.abs(pixel[1]-128)<=2&&Math.abs(pixel[2]-191)<=2&&pixel[3]>=253;
        if(shader)gl.deleteShader(shader);
        self.postMessage({supported,webgl2,reason:supported?'verified':'worker-webgl-readback-failed'});
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }catch(error){self.postMessage({supported:false,webgl2:false,reason:error.message});}
    };`;
    let worker;
    let url;
    let timer;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve(result);
    };
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const offscreen = canvas.transferControlToOffscreen();
      url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(url, { name: 'Octo graphics capability probe' });
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = () => finish({ supported: false, webgl2: false, reason: 'worker-graphics-error' });
      timer = setTimeout(() => finish({ supported: false, webgl2: false, reason: 'worker-graphics-timeout' }), 2000);
      worker.postMessage(offscreen, [offscreen]);
    } catch (error) {
      finish({ supported: false, webgl2: false, reason: error.message });
    }
  });
  return cachedProbe;
}
