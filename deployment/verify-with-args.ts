// TypeScript
import { network, run } from "hardhat";
import { getDeployedContracts } from "./deployUtils";
async function verifyContract(): Promise<void> {
    const chainId = network.config.chainId!;
    console.log(`ChainId: ${chainId}`);

    const chainName = network.name;
    console.log(`ChainName: ${chainName}`);
    const deployedContracts = await getDeployedContracts(chainName);

    const args: unknown[] = [
        0,
        ["0x60891b087E81Ee2a61B7606f68019ec112c539B9"],
        ["0x60891b087E81Ee2a61B7606f68019ec112c539B9"],
        "0x0000000000000000000000000000000000000000",
    ];

    // * only verify on testnets or mainnets.
    if (chainId != 31337 && process.env.ETHERSCAN_API_KEY) {
        await verify("0xcb7C5e41DD9212c3C565633BF4878399B0496947", args);
    }
}

const verify = async (contractAddress: string, args: unknown[]) => {
    console.log("Verifying contract...");
    try {
        await run("verify:verify", {
            address: contractAddress,
            constructorArguments: args,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        if (e.message.toLowerCase().includes("already verified")) {
            console.log("Already verified!");
        } else {
            console.log(e);
        }
    }
};

verifyContract()
    .then(() => process.exit(0))
    .catch((error) => {
        console.log(error);
        process.exit(1);
    });
