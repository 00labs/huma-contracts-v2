import { PoolName, deployPools } from "./deploy-local-test-pools";

(async () => {
    try {
        await deployPools(PoolName.ArfV2);
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
})();
