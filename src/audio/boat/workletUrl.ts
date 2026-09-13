/** §T.183 the bundled worklet's URL. Its own module so node tests never touch Vite's `?worker&url`. */
import url from './boatAudio.worklet.ts?worker&url';

export default url;
