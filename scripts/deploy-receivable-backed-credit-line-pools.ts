import { LocalPoolName } from "../test/constants";
import { deployPools } from "./deploy-local-test-pools";

(async () => {
    try {
        await deployPools(LocalPoolName.ReceivableBackedCreditLine);
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
})();
