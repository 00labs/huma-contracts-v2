import { deployPools } from "./deploy-local-test-pools";

(async () => {
    try {
        await deployPools();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
})();
