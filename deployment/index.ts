import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    BaseTranchesPolicy,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    IPoolCredit,
    FirstLossCover,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    TrancheVault,
} from "../typechain-types";
import { toToken } from "./commonUtils";
import { deploy } from "./deployUtils";
import { get } from "http";

export type ProtocolContracts = [EvaluationAgentNFT, HumaConfig, MockToken];
export type PoolContracts = [
    PoolConfig,
    PlatformFeeManager,
    PoolVault,
    Calendar,
    FirstLossCover,
    BaseTranchesPolicy,
    Pool,
    EpochManager,
    TrancheVault,
    TrancheVault,
    IPoolCredit,
    BaseCreditFeeManager,
    BasePnLManager,
];
export type TranchesPolicyContractName = "FixedAprTranchesPolicy" | "RiskAdjustedTranchesPolicy";
export type CreditContractName =
    | "Credit"
    | "DynamicYieldCredit"
    | "ReceivableFactoringCredit"
    | "CreditFacility"
    | "CreditLine"
    | "ReceivableCredit"
    | "MockPoolCredit";

const CALENDAR_UNIT_DAY = 0;
const CALENDAR_UNIT_MONTH = 1;
const SENIOR_TRANCHE_INDEX = 0;
const JUNIOR_TRANCHE_INDEX = 1;
const DEFAULT_DECIMALS_FACTOR = 10n ** 18n;
const BP_FACTOR = BN.from(10000);
const SECONDS_IN_YEAR = 60 * 60 * 24 * 365;

export const CONSTANTS = {
    CALENDAR_UNIT_DAY,
    CALENDAR_UNIT_MONTH,
    SENIOR_TRANCHE_INDEX,
    JUNIOR_TRANCHE_INDEX,
    DEFAULT_DECIMALS_FACTOR,
    BP_FACTOR,
    SECONDS_IN_YEAR,
};

// const mockTokenContract = new ethers.Contract('0x6Dfb932F9fDd38E4B3D2f6AAB0581a05a267C13C', MockTokenAbi) as MockToken

export async function deployProtocolContracts(
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress,
    poolOwner: SignerWithAddress,
): Promise<ProtocolContracts> {
    const eaNFTContract = await deploy("EvaluationAgentNFT", "EvaluationAgentNFT");

    const humaConfigContract = await deploy("HumaConfig", "HumaConfig");
    await humaConfigContract.setHumaTreasury(treasury.getAddress());
    await humaConfigContract.setTreasuryFee(2000);
    await humaConfigContract.setEANFTContractAddress(eaNFTContract.address);
    await humaConfigContract.setEAServiceAccount(eaServiceAccount.getAddress());
    await humaConfigContract.setPDSServiceAccount(pdsServiceAccount.getAddress());

    await humaConfigContract.addPauser(protocolOwner.getAddress());
    await humaConfigContract.addPauser(poolOwner.getAddress());

    await humaConfigContract.transferOwnership(protocolOwner.getAddress());
    if (await humaConfigContract.connect(protocolOwner).paused())
        await humaConfigContract.connect(protocolOwner).unpause();

    const mockTokenContract = await deploy("MockToken", "MockToken");

    await humaConfigContract
        .connect(protocolOwner)
        .setLiquidityAsset(mockTokenContract.address, true);

    return [eaNFTContract, humaConfigContract, mockTokenContract];
}

async function deployPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: SignerWithAddress,
    poolOwner: SignerWithAddress,
    creditContractName: CreditContractName,
): Promise<PoolContracts> {
    const poolConfigContract = await deploy("PoolConfig", "PoolConfig");

    const platformFeeManagerContract = await deploy("PlatformFeeManager", "PlatformFeeManager");

    const poolVaultContract = await deploy("PoolVault", "PoolVault");

    const poolOwnerAndEAFirstLossCoverContract = await deploy("FirstLossCover", "FirstLossCover");

    const tranchesPolicyContract = await deploy(
        tranchesPolicyContractName,
        tranchesPolicyContractName,
    );

    const poolContract = await deploy("Pool", "Pool");

    const epochManagerContract = await deploy("EpochManager", "EpochManager");

    const seniorTrancheVaultContract = await deploy("TrancheVault", "SeniorTrancheVault");
    const juniorTrancheVaultContract = await deploy("TrancheVault", "JuniorTrancheVault");

    const calendarContract = await deploy("Calendar", "Calendar");

    // const MockCredit = await ethers.getContractFactory("MockCredit");
    // const mockCreditContract = await MockCredit.deploy(poolConfig.address);
    // await mockCreditContract.deployed();

    const creditContract = await deploy(creditContractName, creditContractName);

    const creditFeeManagerContract = await deploy("BaseCreditFeeManager", "BaseCreditFeeManager");

    const creditPnlManagerContract = await deploy(
        "LinearMarkdownPnLManager",
        "LinearMarkdownPnLManager",
    );

    await poolConfigContract.initialize("Test Pool", [
        humaConfigContract.address,
        mockTokenContract.address,
        platformFeeManagerContract.address,
        poolVaultContract.address,
        calendarContract.address,
        poolOwnerAndEAFirstLossCoverContract.address,
        tranchesPolicyContract.address,
        poolContract.address,
        epochManagerContract.address,
        seniorTrancheVaultContract.address,
        juniorTrancheVaultContract.address,
        creditContract.address,
        creditFeeManagerContract.address,
        creditPnlManagerContract.address,
    ]);
    console.log("Test pool Initialized");

    await poolConfigContract.grantRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    console.log("Pool owner granted admin role");

    await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );
    console.log("Deployer granted admin role");

    await platformFeeManagerContract.initialize(poolConfigContract.address);
    console.log("Platform fee manager initialized");
    await poolVaultContract.initialize(poolConfigContract.address);
    console.log("Pool vault initialized");
    await poolOwnerAndEAFirstLossCoverContract.initialize(poolConfigContract.address);
    console.log("Pool owner and EA first loss cover initialized");
    await tranchesPolicyContract.initialize(poolConfigContract.address);
    console.log("Tranches policy initialized");
    await poolContract.initialize(poolConfigContract.address);
    console.log("Pool initialized");
    await epochManagerContract.initialize(poolConfigContract.address);
    console.log("Epoch manager initialized");
    await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Senior Tranche Vault",
        "STV",
        poolConfigContract.address,
        SENIOR_TRANCHE_INDEX,
    );
    console.log("Senior tranche vault initialized");
    await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Junior Tranche Vault",
        "JTV",
        poolConfigContract.address,
        JUNIOR_TRANCHE_INDEX,
    );
    console.log("Junior tranche vault initialized");
    await creditContract.connect(poolOwner).initialize(poolConfigContract.address);
    console.log("Credit contract initialized");
    await creditFeeManagerContract.initialize(poolConfigContract.address);
    console.log("Credit fee manager initialized");
    await creditPnlManagerContract.initialize(poolConfigContract.address);
    console.log("Credit PnL manager initialized");

    return [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
    ];
}

export async function setupPoolContracts(
    poolConfigContract: PoolConfig,
    eaNFTContract: EvaluationAgentNFT,
    mockTokenContract: MockToken,
    poolOwnerAndEAFirstLossCoverContract: FirstLossCover,
    poolVaultContract: PoolVault,
    poolContract: Pool,
    juniorTrancheVaultContract: TrancheVault,
    seniorTrancheVaultContract: TrancheVault,
    creditContract: IPoolCredit,
    poolOwner: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
): Promise<void> {
    await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000_000));
    console.log("Pool liquidity cap set");
    await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));
    console.log("Pool max creditline set");

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());
    console.log("Pool owner treasury set");
    await poolConfigContract.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(625, 10);
    console.log("Pool owner rewards and liquidity set");

    let eaNFTTokenId;
    const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
    const receipt = await tx.wait();
    for (const evt of receipt.events!) {
        if (evt.event === "NFTGenerated") {
            eaNFTTokenId = evt.args!.tokenId;
        }
    }
    console.log("EA NFT minted");
    await poolConfigContract
        .connect(poolOwner)
        .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress());
    console.log("Evaluation agent set");
    await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(1875, 10);
    console.log("EA rewards and liquidity set");

    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwner)
        .setOperator(poolOwnerTreasury.getAddress(), {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    console.log("Pool owner and EA first loss cover poolOwnerTreasury set");
    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwner)
        .setOperator(evaluationAgent.getAddress(), {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    console.log("Pool owner and EA first loss cover evaluationAgent set");

    let role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    console.log("Pool owner granted pool operator role");
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());
    console.log("Pool operator granted pool operator role");

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    console.log("Mock token approved for pool owner treasury");
    await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(100_000_000));
    console.log("Mock token minted for pool owner treasury");
    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .addCover(toToken(10_000_000));
    console.log("Pool owner treasury added cover");

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    console.log("Mock token approved for evaluation agent");
    await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(100_000_000));
    console.log("Mock token minted for evaluation agent");
    await poolOwnerAndEAFirstLossCoverContract
        .connect(evaluationAgent)
        .addCover(toToken(10_000_000));
    console.log("Evaluation agent added cover");

    // Set pool epoch window to 3 days for testing purposes
    await poolConfigContract.connect(poolOwner).setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_DAY, 3);
    console.log("Pool epoch window set");

    await poolContract.connect(poolOwner).enablePool();
    console.log("Pool enabled");
    expect(await poolContract.totalAssets()).to.equal(0);
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
    expect(await juniorTrancheVaultContract.totalSupply()).to.equal(0);
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(0);
    expect(await seniorTrancheVaultContract.totalSupply()).to.equal(0);

    for (let i = 0; i < accounts.length; i++) {
        console.log("********************");
        console.log("Add approved lender and approve mock token: ", accounts[i]);
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress());
        console.log("Junior tranche vault approved lender added");
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress());
        console.log("Senior tranche vault approved lender added");
        await mockTokenContract
            .connect(accounts[i])
            .approve(poolVaultContract.address, ethers.constants.MaxUint256);
        console.log("Mock token approved for pool vault");
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        console.log("Mock token approved for credit contract");
        await mockTokenContract.mint(accounts[i].getAddress(), toToken(100_000_000));
        console.log("Mock token minted for account");
    }
}

export async function deployAndSetupPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken,
    eaNFTContract: EvaluationAgentNFT,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: SignerWithAddress,
    poolOwner: SignerWithAddress,
    creditContractName: CreditContractName,
    evaluationAgent: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
): Promise<PoolContracts> {
    let [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
    ] = await deployPoolContracts(
        humaConfigContract,
        mockTokenContract,
        tranchesPolicyContractName,
        deployer,
        poolOwner,
        creditContractName,
    );

    await setupPoolContracts(
        poolConfigContract,
        eaNFTContract,
        mockTokenContract,
        poolOwnerAndEAFirstLossCoverContract,
        poolVaultContract,
        poolContract,
        juniorTrancheVaultContract,
        seniorTrancheVaultContract,
        creditContract,
        poolOwner,
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        accounts,
    );

    return [
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
    ];
}

export async function deployContracts() {
    const [
        defaultDeployer,
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        seniorLender,
        juniorLender,
    ] = await ethers.getSigners();

    const [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
    );

    await deployAndSetupPoolContracts(
        humaConfigContract,
        mockTokenContract,
        eaNFTContract,
        "FixedAprTranchesPolicy",
        defaultDeployer,
        poolOwner,
        "MockPoolCredit",
        evaluationAgent,
        poolOwnerTreasury,
        poolOperator,
        [seniorLender, juniorLender],
    );
}

deployContracts();

export const getContracts = async () => {
    const { default: contracts } = await import("./maticmum-deployed-contracts.json");
    const { default: PoolConfigAbi } = await import("../abi/PoolConfig.json");
    const { default: PlatformFeeManagerAbi } = await import("../abi/PlatformFeeManager.json");
    const { default: PoolVaultAbi } = await import("../abi/PoolVault.json");
    const { default: CalendarAbi } = await import("../abi/Calendar.json");
    const { default: FirstLossCoverAbi } = await import("../abi/FirstLossCover.json");
    const { default: BaseTranchesPolicy } = await import("../abi/BaseTranchesPolicy.json");
    const { default: PoolAbi } = await import("../abi/Pool.json");
    const { default: EpochManagerAbi } = await import("../abi/EpochManager.json");
    const { default: TrancheVaultAbi } = await import("../abi/TrancheVault.json");
    const { default: CreditAbi } = await import("../abi/Credit.json");
    const { default: BaseCreditFeeManagerAbi } = await import("../abi/BaseCreditFeeManager.json");
    const { default: BasePnLManagerAbi } = await import("../abi/BasePnLManager.json");
    const { default: MockTokenAbi } = await import("../abi/MockToken.json");
    const { default: EvaluationAgentNFTAbi } = await import("../abi/EvaluationAgentNFT.json");

    const poolConfigContract = new ethers.Contract(
        contracts.PoolConfig,
        PoolConfigAbi,
    ) as PoolConfig;

    const platformFeeManagerContract = new ethers.Contract(
        contracts.PlatformFeeManager,
        PlatformFeeManagerAbi,
    ) as PlatformFeeManager;

    const poolVaultContract = new ethers.Contract(contracts.PoolVault, PoolVaultAbi) as PoolVault;
    const calendarContract = new ethers.Contract(contracts.Calendar, CalendarAbi) as Calendar;
    const poolOwnerAndEAFirstLossCoverContract = new ethers.Contract(
        contracts.FirstLossCover,
        FirstLossCoverAbi,
    ) as FirstLossCover;
    const tranchesPolicyContract = new ethers.Contract(
        contracts.FixedAprTranchesPolicy,
        BaseTranchesPolicy,
    ) as BaseTranchesPolicy;
    const poolContract = new ethers.Contract(contracts.Pool, PoolAbi) as Pool;
    const epochManagerContract = new ethers.Contract(
        contracts.EpochManager,
        EpochManagerAbi,
    ) as EpochManager;
    const seniorTrancheVaultContract = new ethers.Contract(
        contracts.SeniorTrancheVault,
        TrancheVaultAbi,
    ) as TrancheVault;
    const juniorTrancheVaultContract = new ethers.Contract(
        contracts.JuniorTrancheVault,
        TrancheVaultAbi,
    ) as TrancheVault;
    const creditContract = new ethers.Contract(contracts.MockPoolCredit, CreditAbi) as IPoolCredit;
    const creditFeeManagerContract = new ethers.Contract(
        contracts.BaseCreditFeeManager,
        BaseCreditFeeManagerAbi,
    ) as BaseCreditFeeManager;
    const creditPnlManagerContract = new ethers.Contract(
        contracts.LinearMarkdownPnLManager,
        BasePnLManagerAbi,
    ) as BasePnLManager;
    const mockTokenContract = new ethers.Contract(contracts.MockToken, MockTokenAbi) as MockToken;
    const eaNFTContract = new ethers.Contract(
        contracts.EvaluationAgentNFT,
        EvaluationAgentNFTAbi,
    ) as EvaluationAgentNFT;

    return {
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
        mockTokenContract,
        eaNFTContract,
    };
};

export async function setupPoolContractsInternal(): Promise<void> {
    const {
        poolConfigContract,
        platformFeeManagerContract,
        poolVaultContract,
        calendarContract,
        poolOwnerAndEAFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditFeeManagerContract,
        creditPnlManagerContract,
        mockTokenContract,
        eaNFTContract,
    } = await getContracts();

    const accounts = await ethers.getSigners();
    const [
        defaultDeployer,
        protocolOwner,
        treasury,
        eaServiceAccount,
        pdsServiceAccount,
        poolOwner,
        poolOwnerTreasury,
        evaluationAgent,
        poolOperator,
        seniorLender,
        juniorLender,
    ] = accounts;

    await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000_000));
    console.log("Pool liquidity cap set");
    await poolConfigContract.connect(poolOwner).setMaxCreditLine(toToken(10_000_000));
    console.log("Pool max creditline set");

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());
    console.log("Pool owner treasury set");
    await poolConfigContract.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(625, 10);
    console.log("Pool owner rewards and liquidity set");

    let eaNFTTokenId;
    const tx = await eaNFTContract.connect(poolOwner).mintNFT(evaluationAgent.address);
    const receipt = await tx.wait();
    for (const evt of receipt.events!) {
        if (evt.event === "NFTGenerated") {
            eaNFTTokenId = evt.args!.tokenId;
        }
    }
    console.log("EA NFT minted");
    await poolConfigContract
        .connect(poolOwner)
        .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress());
    console.log("Evaluation agent set");
    await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(1875, 10);
    console.log("EA rewards and liquidity set");

    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwner)
        .setOperator(poolOwnerTreasury.getAddress(), {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    console.log("Pool owner and EA first loss cover poolOwnerTreasury set");
    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwner)
        .setOperator(evaluationAgent.getAddress(), {
            poolCapCoverageInBps: 100,
            poolValueCoverageInBps: 100,
        });
    console.log("Pool owner and EA first loss cover evaluationAgent set");

    let role = await poolConfigContract.POOL_OPERATOR_ROLE();
    // let role = "0xb33da3d30c8b734b741ef435441a8aa7b574459ef10d6ab4cf5c8bfb56fe18e8";
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    console.log("Pool owner granted pool operator role");
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());
    console.log("Pool operator granted pool operator role");

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    console.log("Mock token approved for pool owner treasury");
    await mockTokenContract
        .connect(poolOwnerTreasury)
        .mint(poolOwnerTreasury.getAddress(), toToken(100_000_000));
    console.log("Mock token minted for pool owner treasury");
    await poolOwnerAndEAFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .addCover(toToken(10_000_000));
    console.log("Pool owner treasury added cover");

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolOwnerAndEAFirstLossCoverContract.address, ethers.constants.MaxUint256);
    console.log("Mock token approved for evaluation agent");
    await mockTokenContract
        .connect(evaluationAgent)
        .mint(evaluationAgent.getAddress(), toToken(100_000_000));
    console.log("Mock token minted for evaluation agent");
    await poolOwnerAndEAFirstLossCoverContract
        .connect(evaluationAgent)
        .addCover(toToken(10_000_000));
    console.log("Evaluation agent added cover");

    // Set pool epoch window to 3 days for testing purposes
    await poolConfigContract.connect(poolOwner).setPoolPayPeriod(CONSTANTS.CALENDAR_UNIT_DAY, 3);
    console.log("Pool epoch window set");

    await poolContract.connect(poolOwner).enablePool();
    console.log("Pool enabled");

    console.log("accounts length: ", accounts.length);
    for (let i = 0; i < accounts.length; i++) {
        console.log("********************");
        console.log("Add approved lender and approve mock token: ", i);
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress());
        console.log("Junior tranche vault approved lender added");
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress());
        console.log("Senior tranche vault approved lender added");
        await mockTokenContract
            .connect(accounts[i])
            .approve(poolVaultContract.address, ethers.constants.MaxUint256);
        console.log("Mock token approved for pool vault");
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        console.log("Mock token approved for credit contract");
        await mockTokenContract
            .connect(accounts[i])
            .mint(accounts[i].getAddress(), toToken(100_000_000));
        console.log("Mock token minted for account");
    }
}

// setupPoolContractsInternal();
