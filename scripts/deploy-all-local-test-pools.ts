import { deployPools } from "./deploy-local-test-pools";

(async () => {
    try {
        await deployPools(undefined, false);
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
})();
