/* eslint-disable no-undef */
//@ts-nocheck
import { Wallet } from "ethers";

const ACCOUNT_PRIVATE_KEY = process.env.DEPLOYER;
const TO_ADDRESS = "0xA0CA5AB0634486948a2bd5191fF4B38F2ff8c2e8";

async function main() {
    const network = (await hre.ethers.provider.getNetwork()).name;
    console.log("network : ", network);
    const account = new Wallet(ACCOUNT_PRIVATE_KEY as string, await hre.ethers.provider);
    console.log("account address: " + account.address);
    const txCount = await account.getTransactionCount("latest");
    console.log(`transaction account: ${txCount}`);
    const txPendingCount = await account.getTransactionCount("pending");
    console.log(`transaction pending account: ${txPendingCount}`);

    // if (txPendingCount > txCount) {
    //     for (let i = txCount; i < txPendingCount; i++) {
    //         console.log("Start override nonce: " + i);
    //         const data = {
    //             to: TO_ADDRESS,
    //             maxFeePerGas: utils.parseUnits("200", "gwei"),
    //             maxPriorityFeePerGas: utils.parseUnits("100", "gwei"),
    //             nonce: i,
    //             // eslint-disable-next-line @typescript-eslint/no-explicit-any
    //         } as any;

    //         const tx = await account.sendTransaction(data);
    //         console.log(`send cancel tx: ${JSON.stringify(tx)}`);
    //         await tx.wait();
    //         console.log("done");
    //     }
    // }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
