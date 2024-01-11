import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { HardhatEthersHelpers } from "hardhat/types";

export const getAccountSigners = async (
    ethersClient: HardhatEthersHelpers,
): Promise<{
    defaultDeployer: SignerWithAddress;
    protocolOwner: SignerWithAddress;
    treasury: SignerWithAddress;
    sentinelServiceAccount: SignerWithAddress;
    poolOwner: SignerWithAddress;
    poolOwnerTreasury: SignerWithAddress;
    evaluationAgent: SignerWithAddress;
    poolOperator: SignerWithAddress;
    juniorLender: SignerWithAddress;
    seniorLender: SignerWithAddress;
    lenderRedemptionActive: SignerWithAddress;
    borrowerActive: SignerWithAddress;
}> => {
    const [
        defaultDeployer,
        protocolOwner,
        treasury,
        sentinelServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        juniorLender,
        seniorLender,
        lenderRedemptionActive,
        borrowerActive,
    ] = await ethersClient.getSigners();

    return {
        defaultDeployer,
        protocolOwner,
        treasury,
        sentinelServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        juniorLender,
        seniorLender,
        lenderRedemptionActive,
        borrowerActive,
    };
};
