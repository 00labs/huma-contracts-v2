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
        ["0x9eA47A502BEffB25c8d559e614203562bb7d886d"],
        ["0x73285f0013F76366e0442180C5Ae3A67Da2ab4fC"],
        "0x0000000000000000000000000000000000000000",
    ];
    // const PoolFactory = await hre.ethers.getContractFactory("PoolFactory", {
    //     libraries: { LibTimelockController: deployedContracts["LibTimelockController"] },
    // });
    // const poolFactoryImpl = PoolFactory.attach(deployedContracts["PoolFactoryImpl"]);
    // const fragment = await poolFactoryImpl.interface.getFunction("initialize(address)");
    // const calldata = await poolFactoryImpl.interface.encodeFunctionData(fragment, [
    //     deployedContracts["HumaConfig"],
    // ]);
    // const args: unknown[] = ["0x077b618a91129435f5110915080c60eea078639f", calldata];

    // * only verify on testnets or mainnets.
    if (chainId != 31337 && process.env.CELOSCAN_API_KEY) {
        await verify("0x47fa6Ffb3021836a321cC36df82a46c2D6eAd44E", args);
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
