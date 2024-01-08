import { PoolName, deployPools } from "./deploy-local-test-pools";

(async () => {
    try {
        await deployPools(PoolName.CreditLine);
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
})();
