import * as wasm from "./mekamb_opaque_wasm_bg.wasm";
import { __wbg_set_wasm } from "./mekamb_opaque_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    ClientStart, LoginStart, clientLoginFinish, clientLoginStart, clientRegisterFinish, clientRegisterStart, generateServerKey, loginFinish, loginStart, registrationFinish, registrationStart, start
} from "./mekamb_opaque_wasm_bg.js";
