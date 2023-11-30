import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
import { ethers, network } from "hardhat";
import { deployAndSetupPoolContracts, deployProtocolContracts } from "../test/BaseTest";
import { getMinFirstLossCoverRequirement, toToken } from "../test/TestUtils";
import {
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let juniorLender: SignerWithAddress,
    seniorLender: SignerWithAddress,
    poolAffiliate: SignerWithAddress,
    lenderRedemptionActive: SignerWithAddress,
    borrowerActive: SignerWithAddress,
    borrowerApproved: SignerWithAddress,
    borrowerNoAutopay: SignerWithAddress,
    borrowerAutopayReady: SignerWithAddress,
    borrowerLate: SignerWithAddress,
    borrowerDefault: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: BorrowerLevelCreditManager;

async function depositFirstLossCover(
    poolContract: Pool,
    coverContract: FirstLossCover,
    account: SignerWithAddress,
) {
    const fetchPoolConfigContractAddr = await poolContract.poolConfig();
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const fetchPoolConfigContract = PoolConfig.attach(fetchPoolConfigContractAddr);

    await coverContract.connect(poolOwner).setCoverProvider(account.address, {
        poolCapCoverageInBps: 1,
        poolValueCoverageInBps: 100,
    });
    await mockTokenContract
        .connect(account)
        .approve(coverContract.address, ethers.constants.MaxUint256);
    await coverContract
        .connect(account)
        .depositCover(
            (
                await getMinFirstLossCoverRequirement(
                    coverContract,
                    fetchPoolConfigContract,
                    poolContract,
                    account.address,
                )
            ).mul(2),
        );
}

async function main() {
    [
        defaultDeployer,
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        juniorLender,
        seniorLender,
        poolAffiliate,
        lenderRedemptionActive,
        borrowerActive,
        borrowerApproved,
        borrowerNoAutopay,
        borrowerAutopayReady,
        borrowerLate,
        borrowerDefault,
    ] = await ethers.getSigners();

    [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
    );

    [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract as unknown,
        creditDueManagerContract,
        creditManagerContract as unknown,
    ] = await deployAndSetupPoolContracts(
        humaConfigContract,
        mockTokenContract,
        eaNFTContract,
        "RiskAdjustedTranchesPolicy",
        defaultDeployer,
        poolOwner,
        "CreditLine",
        "BorrowerLevelCreditManager",
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        [juniorLender, seniorLender, poolAffiliate, lenderRedemptionActive, borrowerActive],
    );

    console.log("Depositing borrower cover into the pool");
    await depositFirstLossCover(poolContract, borrowerFirstLossCoverContract, borrowerActive);

    console.log("Depositing junior and senior liquidity into the tranches");
    await juniorTrancheVaultContract
        .connect(juniorLender)
        .deposit(toToken(150_000), juniorLender.address);
    await seniorTrancheVaultContract
        .connect(seniorLender)
        .deposit(toToken(200_000), seniorLender.address);

    // Drawdown
    const frontLoadingFeeFlat = toToken(100);
    const frontLoadingFeeBps = BN.from(100);
    await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
        frontLoadingFeeFlat: frontLoadingFeeFlat,
        frontLoadingFeeBps: frontLoadingFeeBps,
    });
    const numOfPeriods = 5;
    const yieldInBps = 1217;
    await creditManagerContract
        .connect(eaServiceAccount)
        .approveBorrower(
            borrowerActive.address,
            toToken(100_000),
            numOfPeriods,
            yieldInBps,
            toToken(0),
            0,
            true,
        );
    const borrowAmount = toToken(50_000);
    console.log("Drawing down credit line");
    await creditContract.connect(borrowerActive).drawdown(borrowerActive.address, borrowAmount);

    console.log("Submitting junior redemption request");
    await juniorTrancheVaultContract.connect(juniorLender).addRedemptionRequest(toToken(10_000));

    console.log("Skipping to next epoch");
    const threeDaysInSeconds = 3 * 24 * 60 * 60; // 3 days in seconds
    // Simulate the passage of time by advancing the time on the Hardhat Network
    await network.provider.send("evm_increaseTime", [threeDaysInSeconds]);

    console.log("=====================================");
    console.log("Accounts:");
    console.log(`Junior lender: ${juniorLender.address}`);
    console.log(`Senior lender: ${seniorLender.address}`);
    console.log(`Borrower:      ${borrowerActive.address}`);
    console.log(`PDS service:   ${pdsServiceAccount.address}`);

    console.log("=====================================");
    console.log("Addresses:");
    console.log(`Pool:            ${poolContract.address}`);
    console.log("     (note: pool is ready for junior redemption epoch processing)");
    console.log(`Epoch manager:   ${epochManagerContract.address}`);
    console.log(`Pool config:     ${poolConfigContract.address}`);
    console.log(`Pool credit:     ${creditContract.address}`);
    console.log(`Junior tranche:  ${juniorTrancheVaultContract.address}`);
    console.log(`Senior tranche:  ${seniorTrancheVaultContract.address}`);
    console.log(`Pool safe:       ${poolSafeContract.address}`);
    console.log(`Test token:      ${mockTokenContract.address}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
