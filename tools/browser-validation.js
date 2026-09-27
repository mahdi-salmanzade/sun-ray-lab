// Opt-in local regression UI. Loaded only with ?verify=1; normal visits do
// not download this module or expose testing controls.
export function installValidation(lab) {
  const panel = document.createElement('details');
  panel.id = 'render-validation';
  panel.open = true;
  panel.style.cssText = 'position:fixed;right:16px;top:100px;z-index:100;background:#101815;color:#eee;padding:14px;width:420px;max-height:70vh;overflow:auto;border:1px solid #a8815a;font:12px monospace';
  panel.innerHTML = '<summary>Local rendering regression</summary><button id="run-validation">Run shadow regression</button><button id="inspect-frame">Inspect current frame</button><pre id="validation-result" style="white-space:pre-wrap">Ready to check.</pre>';
  document.body.appendChild(panel);
  const output = panel.querySelector('pre');
  const inspect = () => ({state: {...lab.state}, camera: lab.camera(), ready: lab.ready(), converged: lab.converged()});
  panel.querySelector('#inspect-frame').onclick = () => { output.textContent = JSON.stringify(inspect(), null, 2); };
  panel.querySelector('#run-validation').onclick = async (event) => {
    event.target.disabled = true;
    const reports = [];
    const settle = () => new Promise((resolve, reject) => {
      const start = performance.now();
      function poll() {
        if (lab.ready() && lab.converged()) resolve();
        else if (performance.now() - start > 90000) reject(new Error('Renderer did not converge within 90s.'));
        else requestAnimationFrame(poll);
      }
      requestAnimationFrame(poll);
    });
    try {
      await settle();
      for (const [azimuth,elevation,yaw,isolate] of [
        [218,33,0,true], [80,31,0,true], [226,69,0,true],
        [218,33,45,true], [80,31,90,true], [218,33,180,true],
        [218,33,0,false],
      ]) {
        output.textContent = `Checking sun ${azimuth}° / ${elevation}°, model yaw ${yaw}°…`;
        lab.set({azimuth,elevation,yaw,isolate,view:'readable',trueSun:false,followShadow:false,window:90,center:null});
        const words = lab.words();
        if (words?.runs.length) {
          const [x,z] = words.runs[0].center;
          lab.set({center:{x,z},window:65});
        }
        await settle();
        reports.push({azimuth,elevation,yaw,isolate,...lab.verifyShadow()});
      }
      output.textContent = JSON.stringify({pass:reports.every(r=>r.pass),reports},null,2);
    } catch(error) {
      output.textContent = JSON.stringify({pass:false,error:error.message,reports},null,2);
    } finally { event.target.disabled = false; }
  };
}
