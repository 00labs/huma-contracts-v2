import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN, BigNumberish, ContractFactory } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";
import {
    BaseTranchesPolicy,
    Calendar,
    CreditDueManager,
    CreditLine,
    CreditLineManager,
    EpochManager,
    FirstLossCover,
    FixedSeniorYieldTranchesPolicy,
    HumaConfig,
    MockPoolCredit,
    MockPoolCreditManager,
    MockToken,
    MockTokenNonStandardERC20,
    Pool,
    PoolConfig,
    PoolFactory,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    ReceivableFactoringCredit,
    ReceivableFactoringCreditManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import { FirstLossCoverConfigStruct } from "../typechain-types/contracts/common/PoolConfig.sol/PoolConfig";
import {
    CreditRecordStruct,
    CreditRecordStructOutput,
    DueDetailStruct,
    DueDetailStructOutput,
} from "../typechain-types/contracts/credit/Credit";
import {
    CreditConfigStruct,
    CreditConfigStructOutput,
} from "../typechain-types/contracts/credit/CreditManager";
import { EpochRedemptionSummaryStruct } from "../typechain-types/contracts/liquidity/interfaces/IRedemptionHandler";
import {
    getFirstLossCoverInfo,
    getLatestBlock,
    getMinLiquidityRequirementForPoolOwner,
    maxBigNumber,
    minBigNumber,
    overrideLPConfig,
    sumBNArray,
    toToken,
} from "./TestUtils";
import { CONSTANTS } from "./constants";

export type CreditContractType =
    | MockPoolCredit
    | CreditLine
    | ReceivableBackedCreditLine
    | ReceivableFactoringCredit;
export type CreditManagerContractType =
    | MockPoolCreditManager
    | CreditLineManager
    | ReceivableBackedCreditLineManager
    | ReceivableFactoringCreditManager;
export type ProtocolContracts = [HumaConfig, MockToken];
export type PoolContracts = [
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Calendar,
    FirstLossCover,
    FirstLossCover,
    BaseTranchesPolicy,
    Pool,
    EpochManager,
    TrancheVault,
    TrancheVault,
    CreditContractType,
    CreditDueManager,
    CreditManagerContractType,
    Receivable,
];
export type PoolImplementations = [
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    FirstLossCover,
    RiskAdjustedTranchesPolicy,
    FixedSeniorYieldTranchesPolicy,
    Pool,
    EpochManager,
    TrancheVault,
    CreditLine,
    ReceivableBackedCreditLine,
    ReceivableFactoringCredit,
    CreditDueManager,
    CreditLineManager,
    ReceivableBackedCreditLineManager,
    ReceivableFactoringCreditManager,
    Receivable,
];

export type PoolRecord = {
    poolId: BN;
    poolAddress: string;
    poolName: string;
    poolStatus: PoolStatus;
    poolConfigAddress: string;
    poolTimelock: string;
};

type CreditType = "creditline" | "receivablebcked" | "receivablefactoring";
type TranchesPolicyType = "fixed" | "adjusted";
export type TranchesPolicyContractName =
    | "FixedSeniorYieldTranchesPolicy"
    | "RiskAdjustedTranchesPolicy";
export type CreditContractName =
    | "CreditLine"
    | "ReceivableBackedCreditLine"
    | "ReceivableFactoringCredit"
    | "MockPoolCredit";
export type CreditManagerContractName =
    | "CreditLineManager"
    | "ReceivableBackedCreditLineManager"
    | "ReceivableFactoringCreditManager"
    | "MockPoolCreditManager";

export enum PayPeriodDuration {
    Monthly,
    Quarterly,
    SemiAnnually,
}

export enum CreditState {
    Deleted,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted,
}

export enum ReceivableState {
    Deleted,
    Minted,
    Approved,
    PartiallyPaid,
    Paid,
    Rejected,
    Delayed,
    Defaulted,
}

export enum PoolStatus {
    Created,
    Initialized,
    Closed,
}

export async function deployProxyContract(
    Contract: ContractFactory,
    initFunction?: string,
    initParams?: unknown[],
) {
    const contractImpl = await Contract.deploy();
    await contractImpl.deployed();

    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    let fragment, calldata;
    if (initFunction) {
        fragment = await Contract.interface.getFunction(initFunction);
        calldata = await Contract.interface.encodeFunctionData(fragment, initParams);
    } else {
        calldata = "0x";
    }
    const contractProxy = await Proxy.deploy(contractImpl.address, calldata);
    await contractProxy.deployed();
    return await Contract.attach(contractProxy.address);
}

export async function deployProtocolContracts(
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress,
    poolOwner: SignerWithAddress,
): Promise<ProtocolContracts> {
    // Deploy HumaConfig
    const HumaConfig = await ethers.getContractFactory("HumaConfig");
    let humaConfigContract = await HumaConfig.deploy();
    await humaConfigContract.deployed();

    await humaConfigContract.setHumaTreasury(treasury.getAddress());
    await humaConfigContract.setSentinelServiceAccount(sentinelServiceAccount.getAddress());

    await humaConfigContract.addPauser(protocolOwner.getAddress());
    await humaConfigContract.addPauser(poolOwner.getAddress());

    await humaConfigContract.transferOwnership(protocolOwner.getAddress());
    if (await humaConfigContract.connect(protocolOwner).paused())
        await humaConfigContract.connect(protocolOwner).unpause();

    const MockToken = await ethers.getContractFactory("MockToken");
    const mockTokenContract = await MockToken.deploy();
    await mockTokenContract.deployed();

    await humaConfigContract
        .connect(protocolOwner)
        .setLiquidityAsset(mockTokenContract.address, true);

    return [humaConfigContract, mockTokenContract];
}

export async function deployPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken | MockTokenNonStandardERC20,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: SignerWithAddress,
    poolOwner: SignerWithAddress,
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
): Promise<PoolContracts> {
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfigContract = (await deployProxyContract(PoolConfig)) as PoolConfig;

    const PoolFeeManager = await ethers.getContractFactory("PoolFeeManager");
    const poolFeeManagerContract = (await deployProxyContract(PoolFeeManager)) as PoolFeeManager;

    const PoolSafe = await ethers.getContractFactory("PoolSafe");
    const poolSafeContract = (await deployProxyContract(PoolSafe)) as PoolSafe;

    const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
    const borrowerFirstLossCoverContract = (await deployProxyContract(
        FirstLossCover,
    )) as FirstLossCover;
    const adminFirstLossCoverContract = (await deployProxyContract(
        FirstLossCover,
    )) as FirstLossCover;

    const TranchesPolicy = await getTranchesPolicyContractFactory(tranchesPolicyContractName);
    const tranchesPolicyContract = (await deployProxyContract(
        TranchesPolicy,
    )) as BaseTranchesPolicy;

    const Pool = await ethers.getContractFactory("Pool");
    const poolContract = (await deployProxyContract(Pool)) as Pool;

    const EpochManager = await ethers.getContractFactory("EpochManager");
    const epochManagerContract = (await deployProxyContract(EpochManager)) as EpochManager;

    const TrancheVault = await ethers.getContractFactory("TrancheVault");
    const seniorTrancheVaultContract = (await deployProxyContract(TrancheVault)) as TrancheVault;
    const juniorTrancheVaultContract = (await deployProxyContract(TrancheVault)) as TrancheVault;

    const Calendar = await ethers.getContractFactory("Calendar");
    const calendarContract = await Calendar.deploy();
    await calendarContract.deployed();

    const Credit = await getCreditContractFactory(creditContractName);
    const creditContract = (await deployProxyContract(Credit)) as CreditContractType;

    const CreditManager = await getCreditManagerContractFactory(creditManagerContractName);
    const creditManagerContract = (await deployProxyContract(
        CreditManager,
    )) as CreditManagerContractType;

    const CreditDueManager = await ethers.getContractFactory("CreditDueManager");
    const creditDueManagerContract = (await deployProxyContract(
        CreditDueManager,
    )) as CreditDueManager;

    const Receivable = await ethers.getContractFactory("Receivable");
    const receivableContract = (await deployProxyContract(Receivable, "initialize")) as Receivable;

    await receivableContract.grantRole(
        receivableContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    await receivableContract.renounceRole(
        receivableContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );

    await poolConfigContract.initialize("Test Pool", [
        humaConfigContract.address,
        mockTokenContract.address,
        calendarContract.address,
        poolContract.address,
        poolSafeContract.address,
        poolFeeManagerContract.address,
        tranchesPolicyContract.address,
        epochManagerContract.address,
        seniorTrancheVaultContract.address,
        juniorTrancheVaultContract.address,
        creditContract.address,
        creditDueManagerContract.address,
        creditManagerContract.address,
    ]);
    await poolConfigContract.setFirstLossCover(
        CONSTANTS.BORROWER_LOSS_COVER_INDEX,
        borrowerFirstLossCoverContract.address,
        {
            coverRatePerLossInBps: 0,
            coverCapPerLoss: 0,
            maxLiquidity: toToken(100_000_000),
            minLiquidity: 0,
            riskYieldMultiplierInBps: 0,
        },
    );
    await poolConfigContract.setReceivableAsset(receivableContract.address);
    await poolConfigContract.setFirstLossCover(
        CONSTANTS.ADMIN_LOSS_COVER_INDEX,
        adminFirstLossCoverContract.address,
        {
            coverRatePerLossInBps: 0,
            coverCapPerLoss: 0,
            maxLiquidity: toToken(100_000_000),
            minLiquidity: 0,
            riskYieldMultiplierInBps: 20000,
        },
    );

    await poolConfigContract.grantRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        poolOwner.getAddress(),
    );
    await poolConfigContract.renounceRole(
        await poolConfigContract.DEFAULT_ADMIN_ROLE(),
        deployer.getAddress(),
    );

    await poolFeeManagerContract.initialize(poolConfigContract.address);
    await poolSafeContract.initialize(poolConfigContract.address);
    await borrowerFirstLossCoverContract["initialize(string,string,address)"](
        "Borrower First Loss Cover",
        "BFLC",
        poolConfigContract.address,
    );
    await adminFirstLossCoverContract["initialize(string,string,address)"](
        "Admin First Loss Cover",
        "AFLC",
        poolConfigContract.address,
    );
    await tranchesPolicyContract.initialize(poolConfigContract.address);
    await poolContract.initialize(poolConfigContract.address);
    await epochManagerContract.initialize(poolConfigContract.address);
    await seniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Senior Tranche Vault",
        "STV",
        poolConfigContract.address,
        CONSTANTS.SENIOR_TRANCHE,
    );
    await juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
        "Junior Tranche Vault",
        "JTV",
        poolConfigContract.address,
        CONSTANTS.JUNIOR_TRANCHE,
    );
    await creditContract.connect(poolOwner).initialize(poolConfigContract.address);
    await creditDueManagerContract.initialize(poolConfigContract.address);
    await creditManagerContract.initialize(poolConfigContract.address);

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        adminFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
        creditManagerContract,
        receivableContract,
    ];
}

export async function deployImplementationContracts(): Promise<PoolImplementations> {
    // Deploy PoolConfig
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfigImpl = await PoolConfig.deploy();
    await poolConfigImpl.deployed();

    // Deploy PoolFeeManager
    const PoolFeeManager = await ethers.getContractFactory("PoolFeeManager");
    const poolFeeManagerImpl = await PoolFeeManager.deploy();
    await poolFeeManagerImpl.deployed();

    // Deploy PoolSafe
    const PoolSafe = await ethers.getContractFactory("PoolSafe");
    const poolSafeImpl = await PoolSafe.deploy();
    await poolSafeImpl.deployed();

    // Deploy FirstLossCover
    const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
    const firstLossCoverImpl = await FirstLossCover.deploy();
    await firstLossCoverImpl.deployed();

    // Deploy RiskAdjustedTranchesPolicy
    const RiskAdjustedTranchesPolicy = await ethers.getContractFactory(
        "RiskAdjustedTranchesPolicy",
    );
    const riskAdjustedTranchesPolicyImpl = await RiskAdjustedTranchesPolicy.deploy();
    await riskAdjustedTranchesPolicyImpl.deployed();

    // Deploy FixedSeniorYieldTranchesPolicy
    const FixedSeniorYieldTranchesPolicy = await ethers.getContractFactory(
        "FixedSeniorYieldTranchesPolicy",
    );
    const fixedSeniorYieldTranchesPolicyImpl = await FixedSeniorYieldTranchesPolicy.deploy();
    await fixedSeniorYieldTranchesPolicyImpl.deployed();

    // Deploy Pool
    const Pool = await ethers.getContractFactory("Pool");
    const poolImpl = await Pool.deploy();
    await poolImpl.deployed();

    // Deploy EpochManager
    const EpochManager = await ethers.getContractFactory("EpochManager");
    const epochManagerImpl = await EpochManager.deploy();
    await epochManagerImpl.deployed();

    // Deploy TrancheVault
    const TrancheVault = await ethers.getContractFactory("TrancheVault");
    const trancheVaultImpl = await TrancheVault.deploy();
    await trancheVaultImpl.deployed();

    // Deploy CreditLine
    const CreditLine = await ethers.getContractFactory("CreditLine");
    const creditLineImpl = await CreditLine.deploy();
    await creditLineImpl.deployed();

    // Deploy CreditDueManager
    const CreditDueManager = await ethers.getContractFactory("CreditDueManager");
    const creditDueManagerImpl = await CreditDueManager.deploy();
    await creditDueManagerImpl.deployed();

    // Deploy CreditLineManager
    const CreditLineManager = await ethers.getContractFactory("CreditLineManager");
    const creditLineManagerImpl = await CreditLineManager.deploy();
    await creditLineManagerImpl.deployed();

    // Deploy ReceivableBackedCreditLine
    const ReceivableBackedCreditLine = await ethers.getContractFactory(
        "ReceivableBackedCreditLine",
    );
    const receivableBackedCreditLineImpl = await ReceivableBackedCreditLine.deploy();
    await receivableBackedCreditLineImpl.deployed();

    // Deploy ReceivableBackedCreditLineManager
    const ReceivableBackedCreditLineManager = await ethers.getContractFactory(
        "ReceivableBackedCreditLineManager",
    );
    const receivableBackedCreditLineManagerImpl = await ReceivableBackedCreditLineManager.deploy();
    await receivableBackedCreditLineManagerImpl.deployed();

    // Deploy ReceivableFactoringCredit
    const ReceivableFactoringCredit = await ethers.getContractFactory("ReceivableFactoringCredit");
    const receivableFactoringCreditImpl = await ReceivableFactoringCredit.deploy();
    await receivableFactoringCreditImpl.deployed();

    // Deploy ReceivableFactoringCreditManager
    const ReceivableFactoringCreditManager = await ethers.getContractFactory(
        "ReceivableFactoringCreditManager",
    );
    const receivableFactoringCreditManagerImpl = await ReceivableFactoringCreditManager.deploy();
    await receivableFactoringCreditManagerImpl.deployed();

    // deploy Receivable
    const Receivable = await ethers.getContractFactory("Receivable");
    const receivableImpl = await Receivable.deploy();
    await receivableImpl.deployed();

    return [
        poolConfigImpl,
        poolFeeManagerImpl,
        poolSafeImpl,
        firstLossCoverImpl,
        riskAdjustedTranchesPolicyImpl,
        fixedSeniorYieldTranchesPolicyImpl,
        poolImpl,
        epochManagerImpl,
        trancheVaultImpl,
        creditLineImpl,
        receivableBackedCreditLineImpl,
        receivableFactoringCreditImpl,
        creditDueManagerImpl,
        creditLineManagerImpl,
        receivableBackedCreditLineManagerImpl,
        receivableFactoringCreditManagerImpl,
        receivableImpl,
    ];
}

export async function deployFactory(
    deployer: SignerWithAddress,
    humaConfigContract: HumaConfig,
    calendarContract: Calendar,
    poolConfigImpl: PoolConfig,
    poolFeeManagerImpl: PoolFeeManager,
    poolSafeImpl: PoolSafe,
    firstLossCoverImpl: FirstLossCover,
    riskAdjustedTranchesPolicyImpl: RiskAdjustedTranchesPolicy,
    fixedSeniorYieldTranchesPolicyImpl: FixedSeniorYieldTranchesPolicy,
    poolImpl: Pool,
    epochManagerImpl: EpochManager,
    TrancheVaultImpl: TrancheVault,
    creditLineImpl: CreditLine,
    receivableBackedCreditLineImpl: ReceivableBackedCreditLine,
    receivableFactoringCreditImpl: ReceivableFactoringCredit,
    creditDueManagerImpl: CreditDueManager,
    borrowerLevelCreditManagerImpl: CreditLineManager,
    receivableBackedCreditLineManagerImpl: ReceivableBackedCreditLineManager,
    receivableLevelCreditManagerImpl: ReceivableFactoringCreditManager,
    receivableImpl: Receivable,
): Promise<PoolFactory> {
    const LibTimelockController = await ethers.getContractFactory("LibTimelockController");
    const libTimelockControllerContract = await LibTimelockController.deploy();
    await libTimelockControllerContract.deployed();
    const PoolFactory = await ethers.getContractFactory("PoolFactory", {
        libraries: { LibTimelockController: libTimelockControllerContract.address },
    });

    const poolFactoryContract = (await deployProxyContract(PoolFactory)) as PoolFactory;

    await poolFactoryContract.initialize(humaConfigContract.address);

    await poolFactoryContract.addDeployer(deployer.getAddress());

    // set protocol addresses
    await poolFactoryContract.setCalendarAddress(calendarContract.address);
    await poolFactoryContract.setRiskAdjustedTranchesPolicyImplAddress(
        riskAdjustedTranchesPolicyImpl.address,
    );
    await poolFactoryContract.setFixedSeniorYieldTranchesPolicyImplAddress(
        fixedSeniorYieldTranchesPolicyImpl.address,
    );

    await poolFactoryContract.setCreditLineImplAddress(creditLineImpl.address);
    await poolFactoryContract.setReceivableBackedCreditLineImplAddress(
        receivableBackedCreditLineImpl.address,
    );
    await poolFactoryContract.setReceivableFactoringCreditImplAddress(
        receivableFactoringCreditImpl.address,
    );
    await poolFactoryContract.setReceivableFactoringCreditManagerImplAddress(
        receivableLevelCreditManagerImpl.address,
    );
    await poolFactoryContract.setReceivableBackedCreditLineManagerImplAddress(
        receivableBackedCreditLineManagerImpl.address,
    );
    await poolFactoryContract.setCreditLineManagerImplAddress(
        borrowerLevelCreditManagerImpl.address,
    );

    await poolFactoryContract.setPoolConfigImplAddress(poolConfigImpl.address);
    await poolFactoryContract.setPoolFeeManagerImplAddress(poolFeeManagerImpl.address);
    await poolFactoryContract.setPoolSafeImplAddress(poolSafeImpl.address);
    await poolFactoryContract.setFirstLossCoverImplAddress(firstLossCoverImpl.address);
    await poolFactoryContract.setPoolImplAddress(poolImpl.address);
    await poolFactoryContract.setEpochManagerImplAddress(epochManagerImpl.address);
    await poolFactoryContract.setTrancheVaultImplAddress(TrancheVaultImpl.address);
    await poolFactoryContract.setCreditDueManagerImplAddress(creditDueManagerImpl.address);
    await poolFactoryContract.setReceivableImplAddress(receivableImpl.address);
    return poolFactoryContract;
}

export async function deployReceivableWithFactory(
    poolFactoryContract: PoolFactory,
    receivableOwner: SignerWithAddress,
): Promise<Receivable> {
    const tx = await poolFactoryContract.addReceivable(receivableOwner.getAddress());
    const receipt = await tx.wait();
    let receivableAddress;
    for (const evt of receipt.events!) {
        if (evt.event === "ReceivableCreated") {
            receivableAddress = evt.args!.receivableAddress;
        }
    }
    return await ethers.getContractAt("Receivable", receivableAddress);
}

export async function deployPoolWithFactory(
    poolFactoryContract: PoolFactory,
    mockTokenContract: MockToken | MockTokenNonStandardERC20,
    receivableContract: Receivable,
    creditType: CreditType,
    tranchesPolicyType: TranchesPolicyType,
    poolName: string,
): Promise<PoolRecord> {
    await poolFactoryContract.deployPool(
        poolName,
        mockTokenContract.address,
        receivableContract.address,
        tranchesPolicyType,
        creditType,
    );
    const poolId = await poolFactoryContract.poolId();
    return await poolFactoryContract.checkPool(poolId);
}

export async function setupPoolContracts(
    poolConfigContract: PoolConfig,
    mockTokenContract: MockToken | MockTokenNonStandardERC20,
    borrowerFirstLossCoverContract: FirstLossCover,
    adminFirstLossCoverContract: FirstLossCover,
    poolSafeContract: PoolSafe,
    poolContract: Pool,
    juniorTrancheVaultContract: TrancheVault,
    seniorTrancheVaultContract: TrancheVault,
    creditContract: CreditContractType,
    receivableContract: Receivable,
    poolOwner: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    humaTreasury: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
    shouldSetEA: boolean = true,
): Promise<void> {
    const poolLiquidityCap = toToken(1_000_000_000);
    const settings = await poolConfigContract.getPoolSettings();
    await poolConfigContract
        .connect(poolOwner)
        .setPoolSettings({
            ...settings,
            ...{ maxCreditLine: toToken(10_000_000), principalOnlyPaymentAllowed: true },
        });
    const lpConfig = await poolConfigContract.getLPConfig();
    await poolConfigContract
        .connect(poolOwner)
        .setLPConfig({ ...lpConfig, ...{ liquidityCap: poolLiquidityCap } });

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());

    const role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());

    // Deposit enough liquidity for the pool owner in both tranches.
    const adminRnR = await poolConfigContract.getAdminRnR();
    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(1_000_000_000));
    const poolOwnerLiquidity = await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
    await juniorTrancheVaultContract
        .connect(poolOperator)
        .addApprovedLender(poolOwnerTreasury.getAddress(), true);
    await seniorTrancheVaultContract
        .connect(poolOperator)
        .addApprovedLender(poolOwnerTreasury.getAddress(), true);
    await juniorTrancheVaultContract
        .connect(poolOwnerTreasury)
        .makeInitialDeposit(poolOwnerLiquidity);

    const poolSettings = await poolConfigContract.getPoolSettings();
    expect(await seniorTrancheVaultContract.totalSupply()).to.equal(0);
    expect(
        await seniorTrancheVaultContract.convertToShares(poolSettings.minDepositAmount),
    ).to.equal(poolSettings.minDepositAmount);
    expect(
        await seniorTrancheVaultContract.convertToAssets(poolSettings.minDepositAmount),
    ).to.equal(poolSettings.minDepositAmount);
    await seniorTrancheVaultContract
        .connect(poolOwnerTreasury)
        .makeInitialDeposit(poolSettings.minDepositAmount);
    let expectedInitialLiquidity = poolOwnerLiquidity.add(poolSettings.minDepositAmount);

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(1_000_000_000));
    if (shouldSetEA) {
        await poolConfigContract
            .connect(poolOwner)
            .setEvaluationAgent(evaluationAgent.getAddress());
        const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByEA)
            .mul(poolLiquidityCap)
            .div(CONSTANTS.BP_FACTOR);
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(evaluationAgent.getAddress(), true);
        await juniorTrancheVaultContract
            .connect(evaluationAgent)
            .makeInitialDeposit(evaluationAgentLiquidity);
        expectedInitialLiquidity = expectedInitialLiquidity.add(evaluationAgentLiquidity);
    }

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(adminFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract
        .connect(evaluationAgent)
        .approve(adminFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await adminFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(humaTreasury.getAddress());
    await adminFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(poolOwnerTreasury.getAddress());
    await adminFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(evaluationAgent.getAddress());

    await adminFirstLossCoverContract.connect(poolOwnerTreasury).depositCover(toToken(10_000));
    await adminFirstLossCoverContract.connect(evaluationAgent).depositCover(toToken(10_000));
    await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true);

    await poolContract.connect(poolOwner).enablePool();
    expect(await poolContract.totalAssets()).to.equal(expectedInitialLiquidity);
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
        expectedInitialLiquidity.sub(poolSettings.minDepositAmount),
    );
    expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
        expectedInitialLiquidity.sub(poolSettings.minDepositAmount),
    );
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(poolSettings.minDepositAmount);
    expect(await seniorTrancheVaultContract.totalSupply()).to.equal(poolSettings.minDepositAmount);

    for (let i = 0; i < accounts.length; i++) {
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await mockTokenContract
            .connect(accounts[i])
            .approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        await mockTokenContract.mint(accounts[i].getAddress(), toToken(1_000_000_000));
        await receivableContract
            .connect(poolOwner)
            .grantRole(await receivableContract.MINTER_ROLE(), accounts[i].getAddress());
    }
}

export async function deployAndSetupPoolContracts(
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken | MockTokenNonStandardERC20,
    tranchesPolicyContractName: TranchesPolicyContractName,
    deployer: SignerWithAddress,
    poolOwner: SignerWithAddress,
    creditContractName: CreditContractName,
    creditManagerContractName: CreditManagerContractName,
    evaluationAgent: SignerWithAddress,
    humaTreasury: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    poolOperator: SignerWithAddress,
    accounts: SignerWithAddress[],
    shouldSetEA: boolean = true,
): Promise<PoolContracts> {
    const [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        adminFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
        creditManagerContract,
        receivableContract,
    ] = await deployPoolContracts(
        humaConfigContract,
        mockTokenContract,
        tranchesPolicyContractName,
        deployer,
        poolOwner,
        creditContractName,
        creditManagerContractName,
    );

    await setupPoolContracts(
        poolConfigContract,
        mockTokenContract,
        borrowerFirstLossCoverContract,
        adminFirstLossCoverContract,
        poolSafeContract,
        poolContract,
        juniorTrancheVaultContract,
        seniorTrancheVaultContract,
        creditContract,
        receivableContract,
        poolOwner,
        evaluationAgent,
        humaTreasury,
        poolOwnerTreasury,
        poolOperator,
        accounts,
        shouldSetEA,
    );

    return [
        poolConfigContract,
        poolFeeManagerContract,
        poolSafeContract,
        calendarContract,
        borrowerFirstLossCoverContract,
        adminFirstLossCoverContract,
        tranchesPolicyContract,
        poolContract,
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
        creditContract,
        creditDueManagerContract,
        creditManagerContract,
        receivableContract,
    ];
}

export async function mockDistributePnL(
    creditContract: MockPoolCredit,
    creditManagerContract: MockPoolCreditManager,
    profit: BigNumberish,
    loss: BigNumberish,
    lossRecovery: BigNumberish,
) {
    await creditContract.mockDistributeProfit(profit);
    await creditManagerContract.mockDistributeLoss(loss);
    await creditContract.mockDistributeLossRecovery(lossRecovery);
}

export type SeniorYieldTracker = { totalAssets: BN; unpaidYield: BN; lastUpdatedDate: BN };

async function calcLatestSeniorTracker(
    calendarContract: Calendar,
    currentTS: number,
    yieldInBps: number,
    seniorYieldTracker: SeniorYieldTracker,
): Promise<SeniorYieldTracker> {
    const newSeniorTracker = { ...seniorYieldTracker };
    const startOfNextDay = await calendarContract.getStartOfNextDay(currentTS);
    const daysDiff = await calendarContract.getDaysDiff(
        newSeniorTracker.lastUpdatedDate,
        startOfNextDay,
    );
    if (daysDiff.gt(0)) {
        newSeniorTracker.unpaidYield = newSeniorTracker.unpaidYield.add(
            newSeniorTracker.totalAssets
                .mul(daysDiff)
                .mul(BN.from(yieldInBps))
                .div(BN.from(CONSTANTS.DAYS_IN_A_YEAR).mul(CONSTANTS.BP_FACTOR)),
        );
        newSeniorTracker.lastUpdatedDate = BN.from(startOfNextDay);
    }
    return newSeniorTracker;
}

async function calcProfitForFixedSeniorYieldPolicy(
    calendarContract: Calendar,
    profit: BN,
    assets: BN[],
    currentTS: number,
    yieldInBps: number,
    seniorYieldTracker: SeniorYieldTracker,
): Promise<[SeniorYieldTracker, BN[]]> {
    const newSeniorTracker = await calcLatestSeniorTracker(
        calendarContract,
        currentTS,
        yieldInBps,
        seniorYieldTracker,
    );
    const seniorProfit = newSeniorTracker.unpaidYield.gt(profit)
        ? profit
        : newSeniorTracker.unpaidYield;
    const juniorProfit = profit.sub(seniorProfit);
    newSeniorTracker.unpaidYield = newSeniorTracker.unpaidYield.sub(seniorProfit);
    newSeniorTracker.totalAssets = assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit);

    return [
        newSeniorTracker,
        [
            assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit),
            assets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit),
        ],
    ];
}

function calcProfitForRiskAdjustedPolicy(profit: BN, assets: BN[], riskAdjustment: BN): BN[] {
    const totalAssets = assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]);

    let seniorProfit = profit
        .mul(assets[CONSTANTS.SENIOR_TRANCHE])
        .mul(CONSTANTS.BP_FACTOR.sub(riskAdjustment))
        .div(totalAssets.mul(CONSTANTS.BP_FACTOR));

    return [
        assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit),
        assets[CONSTANTS.JUNIOR_TRANCHE].add(profit).sub(seniorProfit),
    ];
}

async function calcProfitForFirstLossCovers(
    profit: BN,
    juniorTotalAssets: BN,
    firstLossCoverInfos: (FirstLossCoverInfo | null)[],
): Promise<[BN, BN[]]> {
    const riskWeightedCoverTotalAssets = await Promise.all(
        firstLossCoverInfos.map(async (info, index) => {
            if (!info) {
                return BN.from(0);
            }
            return info.asset
                .mul(await info.config.riskYieldMultiplierInBps)
                .div(CONSTANTS.BP_FACTOR);
        }),
    );
    const totalWeight = juniorTotalAssets.add(sumBNArray(riskWeightedCoverTotalAssets));
    const profitsForFirstLossCovers = riskWeightedCoverTotalAssets.map((value) =>
        profit.mul(value).div(totalWeight),
    );
    const juniorProfit = profit.sub(sumBNArray(profitsForFirstLossCovers));
    return [juniorProfit, profitsForFirstLossCovers];
}

export interface FirstLossCoverInfo {
    config: FirstLossCoverConfigStruct;
    asset: BN;
    coveredLoss: BN;
}

async function calcLossCover(loss: BN, firstLossCoverInfo: FirstLossCoverInfo): Promise<BN[]> {
    const coveredAmount = minBigNumber(
        loss.mul(await firstLossCoverInfo.config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
        BN.from(await firstLossCoverInfo.config.coverCapPerLoss),
        firstLossCoverInfo.asset,
        loss,
    );
    return [loss.sub(coveredAmount), coveredAmount];
}

async function calcLoss(
    loss: BN,
    assets: BN[],
    firstLossCoverInfos: (FirstLossCoverInfo | null)[],
): Promise<BN[][]> {
    const lossesCoveredByFirstLossCovers = [];
    let coveredAmount;
    for (const info of firstLossCoverInfos) {
        if (!info) {
            coveredAmount = BN.from(0);
        } else {
            [loss, coveredAmount] = await calcLossCover(loss, info);
        }
        lossesCoveredByFirstLossCovers.push(coveredAmount);
    }
    const juniorLoss = minBigNumber(loss, assets[CONSTANTS.JUNIOR_TRANCHE]);
    const seniorLoss = minBigNumber(loss.sub(juniorLoss), assets[CONSTANTS.SENIOR_TRANCHE]);

    return [
        [
            assets[CONSTANTS.SENIOR_TRANCHE].sub(seniorLoss),
            assets[CONSTANTS.JUNIOR_TRANCHE].sub(juniorLoss),
        ],
        [seniorLoss, juniorLoss],
        lossesCoveredByFirstLossCovers,
    ];
}

function calcLossRecoveryForFirstLossCover(coveredLoss: BN, recoveryAmount: BN): BN[] {
    const recoveredAmount = minBigNumber(coveredLoss, recoveryAmount);
    return [recoveryAmount.sub(recoveredAmount), recoveredAmount];
}

async function calcLossRecovery(
    lossRecovery: BN,
    assets: BN[],
    losses: BN[],
    lossesCoveredByFirstLossCovers: BN[],
): Promise<[BN, BN[], BN[], BN[]]> {
    const seniorRecovery = lossRecovery.gt(losses[CONSTANTS.SENIOR_TRANCHE])
        ? losses[CONSTANTS.SENIOR_TRANCHE]
        : lossRecovery;
    lossRecovery = lossRecovery.sub(seniorRecovery);
    const juniorRecovery = lossRecovery.gt(losses[CONSTANTS.JUNIOR_TRANCHE])
        ? losses[CONSTANTS.JUNIOR_TRANCHE]
        : lossRecovery;
    lossRecovery = lossRecovery.sub(juniorRecovery);
    const lossRecoveredInFirstLossCovers = [];
    let recoveredAmount;
    for (const coveredLoss of lossesCoveredByFirstLossCovers.slice().reverse()) {
        [lossRecovery, recoveredAmount] = calcLossRecoveryForFirstLossCover(
            coveredLoss,
            lossRecovery,
        );
        lossRecoveredInFirstLossCovers.unshift(recoveredAmount);
    }

    return [
        lossRecovery,
        [
            assets[CONSTANTS.SENIOR_TRANCHE].add(seniorRecovery),
            assets[CONSTANTS.JUNIOR_TRANCHE].add(juniorRecovery),
        ],
        [
            losses[CONSTANTS.SENIOR_TRANCHE].sub(seniorRecovery),
            losses[CONSTANTS.JUNIOR_TRANCHE].sub(juniorRecovery),
        ],
        lossRecoveredInFirstLossCovers,
    ];
}

async function calcRiskAdjustedProfitAndLoss(
    profit: BN,
    loss: BN,
    lossRecovery: BN,
    assets: BN[],
    losses: BN[],
    riskAdjustment: BN,
    firstLossCoverInfos: FirstLossCoverInfo[],
): Promise<[BN[], BN[], BN[], BN[], BN[]]> {
    const assetsAfterProfit = calcProfitForRiskAdjustedPolicy(profit, assets, riskAdjustment);
    const [juniorProfitAfterFirstLossCoverProfitDistribution, profitsForFirstLossCovers] =
        await PnLCalculator.calcProfitForFirstLossCovers(
            assetsAfterProfit[CONSTANTS.JUNIOR_TRANCHE].sub(assets[CONSTANTS.JUNIOR_TRANCHE]),
            assets[CONSTANTS.JUNIOR_TRANCHE],
            firstLossCoverInfos,
        );
    const [assetsAfterLoss, newTranchesLosses, lossesCoveredByFirstLossCovers] =
        await PnLCalculator.calcLoss(
            loss,
            [
                assetsAfterProfit[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE].add(
                    juniorProfitAfterFirstLossCoverProfitDistribution,
                ),
            ],
            firstLossCoverInfos,
        );

    // Add existing losses to new losses to calculate recovery.
    const totalTranchesLosses = [
        newTranchesLosses[CONSTANTS.SENIOR_TRANCHE].add(losses[CONSTANTS.SENIOR_TRANCHE]),
        newTranchesLosses[CONSTANTS.JUNIOR_TRANCHE].add(losses[CONSTANTS.JUNIOR_TRANCHE]),
    ];
    const totalLossesCoveredByFirstLossCovers = firstLossCoverInfos.map((info, index) =>
        info.coveredLoss.add(lossesCoveredByFirstLossCovers[index]),
    );
    const [, assetsAfterRecovery, lossesAfterRecovery, lossesRecoveredByFirstLossCovers] =
        await PnLCalculator.calcLossRecovery(
            lossRecovery,
            assetsAfterLoss,
            totalTranchesLosses,
            totalLossesCoveredByFirstLossCovers,
        );
    return [
        assetsAfterRecovery,
        lossesAfterRecovery,
        profitsForFirstLossCovers,
        lossesRecoveredByFirstLossCovers,
        totalLossesCoveredByFirstLossCovers,
    ];
}

export const PnLCalculator = {
    calcProfitForFixedSeniorYieldPolicy,
    calcLatestSeniorTracker,
    calcProfitForRiskAdjustedPolicy,
    calcProfitForFirstLossCovers,
    calcLoss,
    calcLossRecovery,
    calcRiskAdjustedProfitAndLoss,
};

export class FeeCalculator {
    humaConfigContract: HumaConfig;
    poolConfigContract: PoolConfig;

    constructor(humaConfigContract: HumaConfig, poolConfigContract: PoolConfig) {
        this.humaConfigContract = humaConfigContract;
        this.poolConfigContract = poolConfigContract;
    }

    async calcPoolFeesForDrawdown(borrowedAmount: BN): Promise<BN[]> {
        const [frontLoadingFeeFlat, frontLoadingFeeBps] =
            await this.poolConfigContract.getFrontLoadingFees();
        const profit = frontLoadingFeeFlat.add(
            borrowedAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
        );
        const [protocolFee, poolOwnerFee, eaFee, poolProfit] =
            await this.calcPoolFeesForProfit(profit);
        const amountToBorrower = borrowedAmount.sub(profit);
        return [protocolFee, poolOwnerFee, eaFee, poolProfit, amountToBorrower];
    }

    async calcPoolFeesForProfit(profit: BN): Promise<BN[]> {
        const protocolFeeInBps = await this.humaConfigContract.protocolFeeInBps();
        const adminRnR = await this.poolConfigContract.getAdminRnR();
        const protocolFee = profit.mul(BN.from(protocolFeeInBps)).div(CONSTANTS.BP_FACTOR);
        let remaining = profit.sub(protocolFee);
        const poolOwnerFee = remaining
            .mul(BN.from(adminRnR.rewardRateInBpsForPoolOwner))
            .div(CONSTANTS.BP_FACTOR);
        const eaFee = remaining
            .mul(BN.from(adminRnR.rewardRateInBpsForEA))
            .div(CONSTANTS.BP_FACTOR);
        const poolProfit = remaining.sub(poolOwnerFee.add(eaFee));
        return [protocolFee, poolOwnerFee, eaFee, poolProfit];
    }

    // TODO: try to deprecate this function later
    async calcPoolFeeDistribution(profit: BN): Promise<BN> {
        const protocolFeeInBps = await this.humaConfigContract.protocolFeeInBps();
        const adminRnR = await this.poolConfigContract.getAdminRnR();
        const [, remaining] = calcPoolFees(
            profit,
            protocolFeeInBps,
            adminRnR.rewardRateInBpsForPoolOwner,
            adminRnR.rewardRateInBpsForEA,
        );
        return remaining;
    }
}

export class ProfitAndLossCalculator {
    poolConfigContract: PoolConfig;
    poolContract: Pool;
    calendarContract: Calendar;
    firstLossCoverContracts: (FirstLossCover | null)[];

    tranchesAssets: BN[] = [];
    firstLossCoverInfos: (FirstLossCoverInfo | null)[] = [];

    constructor(
        poolConfigContract: PoolConfig,
        poolContract: Pool,
        calendarContract: Calendar,
        firstLossCoverContracts: (FirstLossCover | null)[],
    ) {
        this.poolConfigContract = poolConfigContract;
        this.poolContract = poolContract;
        this.calendarContract = calendarContract;
        this.firstLossCoverContracts = firstLossCoverContracts;
    }

    async beginProfitCalculation() {
        this.tranchesAssets = await this.poolContract.currentTranchesAssets();
        this.firstLossCoverInfos = await Promise.all(
            this.firstLossCoverContracts.map(async (firstLossCoverContract) => {
                if (!firstLossCoverContract) {
                    return null;
                }
                const asset = await firstLossCoverContract.totalAssets();
                const coveredLoss = await firstLossCoverContract.coveredLoss();
                const config = await this.poolConfigContract.getFirstLossCoverConfig(
                    firstLossCoverContract.address,
                );
                return { asset, config, coveredLoss };
            }),
        );
        await Promise.all(
            this.firstLossCoverContracts.map(async (firstLossCoverContract, index) => {}),
        );
    }

    async endRiskAdjustedProfitCalculation(profit: BN): Promise<[BN[], BN[], BN[]]> {
        return await this._endRiskAdjustedProfitCalculation(profit);
    }
    async endRiskAdjustedProfitAndLossCalculation(
        profit: BN,
        loss: BN,
    ): Promise<[BN[], BN[], BN[]]> {
        let [assets, profitsForAssets, profitsForFirstLossCovers] =
            await this._endRiskAdjustedProfitCalculation(profit);
        this.firstLossCoverInfos.forEach((info, index) => {
            if (info !== null) {
                info.asset = info.asset.add(profitsForFirstLossCovers[index]);
            }
        });

        let [newAssets, lossesForAssets, lossesForFirstLossCovers] = await calcLoss(
            loss,
            assets,
            this.firstLossCoverInfos,
        );

        return [
            newAssets,
            profitsForAssets.map((c, index) => c.sub(lossesForAssets[index])),
            profitsForFirstLossCovers.map((c, index) => c.sub(lossesForFirstLossCovers[index])),
        ];
    }

    async endFixedSeniorYieldProfitCalculation(
        profit: BN,
        tracker: SeniorYieldTracker,
    ): Promise<[BN[], BN[], BN[], SeniorYieldTracker]> {
        return await this._endFixedSeniorYieldProfitCalculation(profit, tracker);
    }

    async endFixedSeniorYieldProfitAndLossCalculation(
        profit: BN,
        tracker: SeniorYieldTracker,
        loss: BN,
    ): Promise<[BN[], BN[], BN[], SeniorYieldTracker]> {
        let [assets, profitsForAssets, profitsForFirstLossCovers, newTracker] =
            await this._endFixedSeniorYieldProfitCalculation(profit, tracker);
        this.firstLossCoverInfos.forEach((info, index) => {
            if (!info) {
                return null;
            }
            info.asset = info.asset.add(profitsForFirstLossCovers[index]);
        });

        let [newAssets, lossesForAssets, lossesForFirstLossCovers] = await calcLoss(
            loss,
            assets,
            this.firstLossCoverInfos,
        );

        return [
            newAssets,
            profitsForAssets.map((c, index) => c.sub(lossesForAssets[index])),
            profitsForFirstLossCovers.map((c, index) => c.sub(lossesForFirstLossCovers[index])),
            newTracker,
        ];
    }

    private async _endRiskAdjustedProfitCalculation(profit: BN): Promise<[BN[], BN[], BN[]]> {
        const lpConfig = await this.poolConfigContract.getLPConfig();
        const assets = await calcProfitForRiskAdjustedPolicy(
            profit,
            this.tranchesAssets,
            BN.from(lpConfig.tranchesRiskAdjustmentInBps),
        );
        const [juniorProfit, firstLossCoverProfits] = await calcProfitForFirstLossCovers(
            assets[CONSTANTS.JUNIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE]),
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
            this.firstLossCoverInfos,
        );
        assets[CONSTANTS.JUNIOR_TRANCHE] =
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit);
        const trancheProfits = [
            assets[CONSTANTS.SENIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.SENIOR_TRANCHE]),
            juniorProfit,
        ];

        return [assets, trancheProfits, firstLossCoverProfits];
    }

    private async _endFixedSeniorYieldProfitCalculation(
        profit: BN,
        tracker: SeniorYieldTracker,
    ): Promise<[BN[], BN[], BN[], SeniorYieldTracker]> {
        let lpConfig = await this.poolConfigContract.getLPConfig();
        let block = await getLatestBlock();
        let [newTracker, assets] = await calcProfitForFixedSeniorYieldPolicy(
            this.calendarContract,
            profit,
            this.tranchesAssets,
            block.timestamp,
            lpConfig.fixedSeniorYieldInBps,
            tracker,
        );

        let [juniorProfit, firstLossCoverProfits] = await calcProfitForFirstLossCovers(
            assets[CONSTANTS.JUNIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE]),
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
            this.firstLossCoverInfos,
        );
        assets[CONSTANTS.JUNIOR_TRANCHE] =
            this.tranchesAssets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit);
        let trancheProfits = [
            assets[CONSTANTS.SENIOR_TRANCHE].sub(this.tranchesAssets[CONSTANTS.SENIOR_TRANCHE]),
            juniorProfit,
        ];

        return [assets, trancheProfits, firstLossCoverProfits, newTracker];
    }
}

export function checkRedemptionSummary(
    redemptionSummary: EpochRedemptionSummaryStruct,
    epochId: BN,
    totalSharesRequested: BN,
    totalSharesProcessed: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    delta: number = 0,
): void {
    expect(redemptionSummary.epochId).to.equal(epochId);
    expect(redemptionSummary.totalSharesRequested).to.be.closeTo(totalSharesRequested, delta);
    expect(redemptionSummary.totalSharesProcessed).to.be.closeTo(totalSharesProcessed, delta);
    expect(redemptionSummary.totalAmountProcessed).to.be.closeTo(totalAmountProcessed, delta);
}

export class EpochChecker {
    epochManagerContract: EpochManager;
    seniorTrancheVaultContract: TrancheVault;
    juniorTrancheVaultContract: TrancheVault;

    constructor(
        epochManagerContract: EpochManager,
        seniorTrancheVaultContract: TrancheVault,
        juniorTrancheVaultContract: TrancheVault,
    ) {
        this.epochManagerContract = epochManagerContract;
        this.seniorTrancheVaultContract = seniorTrancheVaultContract;
        this.juniorTrancheVaultContract = juniorTrancheVaultContract;
    }

    async checkSeniorCurrentRedemptionSummaryEmpty() {
        return await this.checkCurrentRedemptionSummaryEmpty(this.seniorTrancheVaultContract);
    }

    async checkJuniorCurrentRedemptionSummaryEmpty() {
        return await this.checkCurrentRedemptionSummaryEmpty(this.juniorTrancheVaultContract);
    }

    async checkSeniorCurrentRedemptionSummary(
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        return await this.checkCurrentRedemptionSummary(
            this.seniorTrancheVaultContract,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkJuniorCurrentRedemptionSummary(
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        return await this.checkCurrentRedemptionSummary(
            this.juniorTrancheVaultContract,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkSeniorRedemptionSummaryById(
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        await this.checkRedemptionSummaryById(
            this.seniorTrancheVaultContract,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    async checkJuniorRedemptionSummaryById(
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        await this.checkRedemptionSummaryById(
            this.juniorTrancheVaultContract,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }

    private async checkCurrentRedemptionSummaryEmpty(trancheContract: TrancheVault) {
        const epochId = await this.epochManagerContract.currentEpochId();
        const redemptionSummary = await trancheContract.epochRedemptionSummaries(epochId);
        checkRedemptionSummary(redemptionSummary, BN.from(0), BN.from(0), BN.from(0), BN.from(0));
        return epochId;
    }

    private async checkCurrentRedemptionSummary(
        trancheContract: TrancheVault,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        const epochId = await this.epochManagerContract.currentEpochId();
        const redemptionSummary = await trancheContract.epochRedemptionSummaries(epochId);
        checkRedemptionSummary(
            redemptionSummary,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
        return epochId;
    }

    private async checkRedemptionSummaryById(
        trancheContract: TrancheVault,
        epochId: BN,
        sharesRequested: BN = BN.from(0),
        sharesProcessed: BN = BN.from(0),
        amountProcessed: BN = BN.from(0),
        delta: number = 0,
    ) {
        const redemptionSummary = await trancheContract.epochRedemptionSummaries(epochId);
        checkRedemptionSummary(
            redemptionSummary,
            epochId,
            sharesRequested,
            sharesProcessed,
            amountProcessed,
            delta,
        );
    }
}

export function checkCreditConfigsMatch(
    actualCC: CreditConfigStruct,
    expectedCC: CreditConfigStruct,
) {
    expect(actualCC.creditLimit).to.equal(expectedCC.creditLimit);
    expect(actualCC.committedAmount).to.equal(expectedCC.committedAmount);
    expect(actualCC.periodDuration).to.equal(expectedCC.periodDuration);
    expect(actualCC.numOfPeriods).to.equal(expectedCC.numOfPeriods);
    expect(actualCC.revolving).to.equal(expectedCC.revolving);
    expect(actualCC.yieldInBps).to.equal(expectedCC.yieldInBps);
    expect(actualCC.advanceRateInBps).to.equal(expectedCC.advanceRateInBps);
    expect(actualCC.receivableAutoApproval).to.equal(expectedCC.receivableAutoApproval);
}

export function checkCreditConfig(
    creditConfig: CreditConfigStruct,
    creditLimit: BN,
    committedAmount: BN,
    periodDuration: number,
    numOfPeriods: number,
    yieldInBps: number,
    revolving: boolean,
    advanceRateInBps: number,
    receivableAutoApproval: boolean,
) {
    expect(creditConfig.creditLimit).to.equal(creditLimit);
    expect(creditConfig.committedAmount).to.equal(committedAmount);
    expect(creditConfig.periodDuration).to.equal(periodDuration);
    expect(creditConfig.numOfPeriods).to.equal(numOfPeriods);
    expect(creditConfig.yieldInBps).to.equal(yieldInBps);
    expect(creditConfig.revolving).to.equal(revolving);
    expect(creditConfig.advanceRateInBps).to.equal(advanceRateInBps);
    expect(creditConfig.receivableAutoApproval).to.equal(receivableAutoApproval);
}

export function checkCreditRecordsMatch(
    actualCR: CreditRecordStruct,
    expectedCR: CreditRecordStruct,
    delta: BN = BN.from(0),
) {
    expect(actualCR.unbilledPrincipal).to.equal(expectedCR.unbilledPrincipal);
    expect(actualCR.nextDueDate).to.equal(expectedCR.nextDueDate);
    expect(actualCR.nextDue).to.be.closeTo(expectedCR.nextDue, delta);
    expect(actualCR.yieldDue).to.be.closeTo(expectedCR.yieldDue, delta);
    expect(actualCR.totalPastDue).to.equal(expectedCR.totalPastDue);
    expect(actualCR.missedPeriods).to.equal(expectedCR.missedPeriods);
    expect(actualCR.remainingPeriods).to.equal(expectedCR.remainingPeriods);
    expect(actualCR.state).to.equal(expectedCR.state);
}

export function checkCreditRecord(
    creditRecord: CreditRecordStruct,
    unbilledPrincipal: BN,
    nextDueDate: BN | number,
    nextDue: BN,
    yieldDue: BN,
    totalPastDue: BN,
    missedPeriods: number,
    remainingPeriods: number,
    state: CreditState,
) {
    expect(creditRecord.unbilledPrincipal).to.equal(unbilledPrincipal);
    expect(creditRecord.nextDueDate).to.equal(nextDueDate);
    expect(creditRecord.nextDue).to.equal(nextDue);
    expect(creditRecord.yieldDue).to.equal(yieldDue);
    expect(creditRecord.totalPastDue).to.equal(totalPastDue);
    expect(creditRecord.missedPeriods).to.equal(missedPeriods);
    expect(creditRecord.remainingPeriods).to.equal(remainingPeriods);
    expect(creditRecord.state).to.equal(state);
}

export function genDueDetail(ddOverrides: Partial<DueDetailStruct>): DueDetailStruct {
    return {
        ...{
            lateFeeUpdatedDate: 0,
            lateFee: 0,
            yieldPastDue: 0,
            principalPastDue: 0,
            committed: 0,
            accrued: 0,
            paid: 0,
        },
        ...ddOverrides,
    };
}

export function checkDueDetailsMatch(
    actualDD: DueDetailStruct,
    expectedDD: DueDetailStruct,
    delta: BN = BN.from(0),
) {
    expect(actualDD.lateFeeUpdatedDate).to.equal(expectedDD.lateFeeUpdatedDate);
    expect(actualDD.lateFee).to.equal(expectedDD.lateFee);
    expect(actualDD.principalPastDue).to.equal(expectedDD.principalPastDue);
    expect(actualDD.yieldPastDue).to.equal(expectedDD.yieldPastDue);
    expect(actualDD.committed).to.be.closeTo(expectedDD.committed, delta);
    expect(actualDD.accrued).to.be.closeTo(expectedDD.accrued, delta);
    expect(actualDD.paid).to.equal(expectedDD.paid);
}

export function printSeniorYieldTracker(tracker: SeniorYieldTracker) {
    console.log(`[${tracker.totalAssets}, ${tracker.unpaidYield}, ${tracker.lastUpdatedDate}]`);
}

export function checkSeniorYieldTrackersMatch(
    actualST: SeniorYieldTracker,
    expectedST: SeniorYieldTracker,
    delta: BN = BN.from(0),
) {
    expect(actualST.totalAssets).to.be.closeTo(expectedST.totalAssets, delta);
    expect(actualST.unpaidYield).to.be.closeTo(expectedST.unpaidYield, delta);
    expect(actualST.lastUpdatedDate).to.be.closeTo(expectedST.lastUpdatedDate, delta);
}

export function calcYieldDue(cc: CreditConfigStruct, principal: BN, daysPassed: number): [BN, BN] {
    if (daysPassed == 0) {
        return [BN.from(0), BN.from(0)];
    }
    const accrued = calcYield(principal, Number(cc.yieldInBps), daysPassed);
    const committed = calcYield(BN.from(cc.committedAmount), Number(cc.yieldInBps), daysPassed);
    return [accrued, committed];
}

export async function calcYieldDueNew(
    calendarContract: Calendar,
    cc: CreditConfigStructOutput,
    cr: CreditRecordStructOutput,
    dd: DueDetailStructOutput,
    currentDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
): Promise<[BN, BN, [BN, BN]]> {
    const nextBillRefreshDate = getNextBillRefreshDate(
        cr,
        currentDate,
        latePaymentGracePeriodInDays,
    );
    if (currentDate.isSameOrBefore(nextBillRefreshDate)) {
        return [dd.yieldPastDue, cr.yieldDue, [dd.accrued, dd.committed]];
    }

    const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
        cc.periodDuration,
        currentDate.unix(),
    );
    const principal = getPrincipal(cr, dd);
    if (cr.state === CreditState.Approved) {
        const daysUntilNextDue = await calendarContract.getDaysDiff(
            currentDate.unix(),
            nextDueDate,
        );
        const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
            cc,
            principal,
            daysUntilNextDue.toNumber(),
        );
        return [
            BN.from(0),
            maxBigNumber(accruedYieldNextDue, committedYieldNextDue),
            [accruedYieldNextDue, committedYieldNextDue],
        ];
    }
    const periodStartDate = await calendarContract.getStartDateOfPeriod(
        cc.periodDuration,
        currentDate.unix(),
    );
    const daysOverdue = await calendarContract.getDaysDiff(cr.nextDueDate, periodStartDate);
    const daysUntilNextDue = await calendarContract.getDaysDiff(periodStartDate, nextDueDate);

    const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
        cc,
        principal,
        daysOverdue.toNumber(),
    );
    const yieldPastDue = maxBigNumber(accruedYieldPastDue, committedYieldPastDue);
    const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
        cc,
        principal,
        daysUntilNextDue.toNumber(),
    );
    const yieldNextDue = maxBigNumber(accruedYieldNextDue, committedYieldNextDue);
    return [
        yieldPastDue.add(dd.yieldPastDue).add(cr.yieldDue),
        yieldNextDue,
        [accruedYieldNextDue, committedYieldNextDue],
    ];
}

// Returns three values in the following order:
// 1. Unbilled principal
// 2. Principal past due
// 3. Principal next due
export async function calcPrincipalDue(
    calendarContract: Calendar,
    initialPrincipal: BN,
    currentDate: number,
    lastDueDate: number,
    nextDueDate: number,
    periodDuration: number,
    principalRateInBps: number,
): Promise<[BN, BN, BN]> {
    if (currentDate >= nextDueDate) {
        // All principal is past due if the current date has passed the
        // next due date. Note that the next due date can only be the maturity
        // date in this case.
        return [BN.from(0), initialPrincipal, BN.from(0)];
    }
    const totalDaysInFullPeriod = await calendarContract.getTotalDaysInFullPeriod(periodDuration);
    if (lastDueDate == 0) {
        // During first drawdown, there is no principal past due, only next due.
        const daysUntilNextDue = await calendarContract.getDaysDiff(currentDate, nextDueDate);
        const principalNextDue = initialPrincipal
            .mul(principalRateInBps)
            .mul(daysUntilNextDue)
            .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
        return [initialPrincipal.sub(principalNextDue), BN.from(0), principalNextDue];
    }
    // Otherwise, there is both principal past due and next due.
    const periodStartDate = await calendarContract.getStartDateOfPeriod(
        periodDuration,
        currentDate,
    );
    const numPeriodsPassed = await calendarContract.getNumPeriodsPassed(
        periodDuration,
        lastDueDate,
        periodStartDate,
    );
    const principalPastDue = CONSTANTS.BP_FACTOR.pow(numPeriodsPassed)
        .sub(CONSTANTS.BP_FACTOR.sub(principalRateInBps).pow(numPeriodsPassed))
        .mul(initialPrincipal)
        .div(CONSTANTS.BP_FACTOR.pow(numPeriodsPassed));
    const daysUntilNextDue = await calendarContract.getDaysDiff(periodStartDate, nextDueDate);
    const principalNextDue = initialPrincipal
        .sub(principalPastDue)
        .mul(principalRateInBps)
        .mul(daysUntilNextDue)
        .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
    return [
        initialPrincipal.sub(principalPastDue).sub(principalNextDue),
        principalPastDue,
        principalNextDue,
    ];
}

export async function calcPrincipalDueNew(
    calendarContract: Calendar,
    cc: CreditConfigStructOutput,
    cr: CreditRecordStructOutput,
    dd: DueDetailStructOutput,
    currentDate: moment.Moment,
    maturityDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
    principalRateInBps: number,
): Promise<[BN, BN, BN]> {
    const principal = getPrincipal(cr, dd);
    if (
        currentDate.isSameOrBefore(
            getNextBillRefreshDate(cr, currentDate, latePaymentGracePeriodInDays),
        )
    ) {
        // Return the current due info as-is if the current date is within the bill refresh date.
        return [cr.unbilledPrincipal, dd.principalPastDue, cr.nextDue.sub(cr.yieldDue)];
    }
    if (currentDate.isAfter(maturityDate)) {
        // All principal is past due if the current date has passed the maturity date.
        return [BN.from(0), principal, BN.from(0)];
    }
    const totalDaysInFullPeriod = await calendarContract.getTotalDaysInFullPeriod(
        cc.periodDuration,
    );
    if (cr.state === CreditState.Approved) {
        // During first drawdown, there is no principal past due, only next due.
        const daysUntilNextDue = await calendarContract.getDaysDiff(
            currentDate.unix(),
            cr.nextDueDate,
        );
        const principalNextDue = principal
            .mul(principalRateInBps)
            .mul(daysUntilNextDue)
            .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
        return [cr.unbilledPrincipal.sub(principalNextDue), BN.from(0), principalNextDue];
    }
    // Otherwise, there is both principal past due and next due.
    const periodStartDate = await calendarContract.getStartDateOfPeriod(
        cc.periodDuration,
        currentDate.unix(),
    );
    const numPeriodsPassed = await calendarContract.getNumPeriodsPassed(
        cc.periodDuration,
        cr.nextDueDate,
        periodStartDate,
    );
    const principalPastDue = CONSTANTS.BP_FACTOR.pow(numPeriodsPassed)
        .sub(CONSTANTS.BP_FACTOR.sub(principalRateInBps).pow(numPeriodsPassed))
        .mul(cr.unbilledPrincipal)
        .div(CONSTANTS.BP_FACTOR.pow(numPeriodsPassed));
    const remainingPrincipal = cr.unbilledPrincipal.sub(principalPastDue);
    const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
        cc.periodDuration,
        currentDate.unix(),
    );
    const daysUntilNextDue = await calendarContract.getDaysDiff(periodStartDate, nextDueDate);
    let principalNextDue;
    if (nextDueDate.eq(maturityDate.unix())) {
        principalNextDue = remainingPrincipal;
    } else {
        principalNextDue = remainingPrincipal
            .mul(principalRateInBps)
            .mul(daysUntilNextDue)
            .div(totalDaysInFullPeriod.mul(CONSTANTS.BP_FACTOR));
    }
    return [
        remainingPrincipal.sub(principalNextDue),
        principalPastDue.add(dd.principalPastDue).add(cr.nextDue.sub(cr.yieldDue)),
        principalNextDue,
    ];
}

export async function calcLateFee(
    poolConfigContract: PoolConfig,
    calendarContract: Calendar,
    cc: CreditConfigStruct,
    cr: CreditRecordStruct,
    dd: DueDetailStruct,
    timestamp: number = 0,
): Promise<[BN, BN]> {
    const lateFeeInBps = (await poolConfigContract.getFeeStructure()).lateFeeBps;
    let lateFeeStartDate;
    if (cr.state == CreditState.GoodStanding) {
        if (BN.from(cr.nextDue).isZero()) {
            lateFeeStartDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                cr.nextDueDate,
            );
        } else {
            lateFeeStartDate = cr.nextDueDate;
        }
    } else {
        lateFeeStartDate = dd.lateFeeUpdatedDate;
    }
    const currentTS = (await getLatestBlock()).timestamp;
    const lateFeeUpdatedDate = await calendarContract.getStartOfNextDay(
        timestamp === 0 ? currentTS : timestamp,
    );
    const principal = getPrincipal(cr, dd);
    const lateFeeBasis = maxBigNumber(principal, BN.from(cc.committedAmount));
    const lateFeeDays = await calendarContract.getDaysDiff(lateFeeStartDate, lateFeeUpdatedDate);
    return [
        lateFeeUpdatedDate,
        BN.from(dd.lateFee).add(
            lateFeeBasis
                .mul(lateFeeInBps)
                .mul(lateFeeDays)
                .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.DAYS_IN_A_YEAR)),
        ),
    ];
}

export async function calcLateFeeNew(
    poolConfigContract: PoolConfig,
    calendarContract: Calendar,
    cc: CreditConfigStructOutput,
    cr: CreditRecordStructOutput,
    dd: DueDetailStructOutput,
    currentDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
): Promise<[BN, BN]> {
    if (
        (currentDate.isBefore(
            getLatePaymentGracePeriodDeadline(cr, latePaymentGracePeriodInDays),
        ) &&
            cr.state === CreditState.GoodStanding) ||
        (cr.nextDue.isZero() && cr.totalPastDue.isZero()) ||
        cr.state == CreditState.Defaulted
    ) {
        return [dd.lateFeeUpdatedDate, dd.lateFee];
    }
    const lateFeeInBps = (await poolConfigContract.getFeeStructure()).lateFeeBps;
    let lateFeeStartDate;
    if (cr.state == CreditState.GoodStanding) {
        if (cr.nextDue.isZero()) {
            lateFeeStartDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                cr.nextDueDate,
            );
        } else {
            lateFeeStartDate = cr.nextDueDate;
        }
    } else {
        lateFeeStartDate = dd.lateFeeUpdatedDate;
    }
    const lateFeeUpdatedDate = currentDate.clone().add(1, "day").startOf("day");
    const principal = getPrincipal(cr, dd);
    const lateFeeBasis = maxBigNumber(principal, cc.committedAmount);
    const lateFeeDays = await calendarContract.getDaysDiff(
        lateFeeStartDate,
        lateFeeUpdatedDate.unix(),
    );
    return [
        BN.from(lateFeeUpdatedDate.unix()),
        BN.from(dd.lateFee).add(
            lateFeeBasis
                .mul(lateFeeInBps)
                .mul(lateFeeDays)
                .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.DAYS_IN_A_YEAR)),
        ),
    ];
}

export function getPrincipal(cr: CreditRecordStruct, dd: DueDetailStruct): BN {
    return BN.from(cr.unbilledPrincipal)
        .add(BN.from(cr.nextDue).sub(BN.from(cr.yieldDue)))
        .add(BN.from(dd.principalPastDue));
}

export function getNextBillRefreshDate(
    cr: CreditRecordStructOutput,
    currentDate: moment.Moment,
    latePaymentGracePeriodInDays: number,
) {
    const latePaymentDeadline = getLatePaymentGracePeriodDeadline(
        cr,
        latePaymentGracePeriodInDays,
    );
    if (cr.state === CreditState.GoodStanding && currentDate.isBefore(latePaymentDeadline)) {
        // If this is the first time ever that the bill has surpassed the due date, then we don't want to refresh
        // the bill since we want the user to focus on paying off the current due.
        return latePaymentDeadline;
    }
    return moment.utc(cr.nextDueDate.toNumber() * 1000);
}

export function getLatePaymentGracePeriodDeadline(
    cr: CreditRecordStructOutput,
    latePaymentGracePeriodInDays: number,
) {
    return moment.utc(cr.nextDueDate.toNumber() * 1000).add(latePaymentGracePeriodInDays, "days");
}

export function getTotalDaysInPeriod(periodDuration: number) {
    switch (periodDuration) {
        case PayPeriodDuration.Monthly:
            return CONSTANTS.DAYS_IN_A_MONTH;
        case PayPeriodDuration.Quarterly:
            return CONSTANTS.DAYS_IN_A_QUARTER;
        case PayPeriodDuration.SemiAnnually:
            return CONSTANTS.DAYS_IN_A_HALF_YEAR;
        default:
            throw Error("Invalid period duration");
    }
}

export function printCreditRecord(name: string, creditRecord: CreditRecordStruct) {
    console.log(
        `${name}[
            unbilledPrincipal: ${creditRecord.unbilledPrincipal},
            nextDueDate: ${creditRecord.nextDueDate},
            nextDue: ${creditRecord.nextDue},
            yieldDue: ${creditRecord.yieldDue},
            totalPastDue: ${creditRecord.totalPastDue},
            missedPeriods: ${creditRecord.missedPeriods},
            remainingPeriods: ${creditRecord.remainingPeriods},
            state: ${creditRecord.state}]`,
    );
}

async function getTranchesPolicyContractFactory(
    tranchesPolicyContractName: TranchesPolicyContractName,
) {
    switch (tranchesPolicyContractName) {
        case "FixedSeniorYieldTranchesPolicy":
        case "RiskAdjustedTranchesPolicy":
            return await ethers.getContractFactory(tranchesPolicyContractName);
        default:
            throw new Error("Invalid tranchesPolicyContractName");
    }
}

async function getCreditContractFactory(creditContractName: CreditContractName) {
    switch (creditContractName) {
        case "CreditLine":
        case "ReceivableBackedCreditLine":
        case "ReceivableFactoringCredit":
        case "MockPoolCredit":
            return await ethers.getContractFactory(creditContractName);
        default:
            throw new Error("Invalid creditContractName");
    }
}

async function getCreditManagerContractFactory(
    creditManagerContractName: CreditManagerContractName,
) {
    switch (creditManagerContractName) {
        case "CreditLineManager":
        case "ReceivableBackedCreditLineManager":
        case "ReceivableFactoringCreditManager":
        case "MockPoolCreditManager":
            return await ethers.getContractFactory(creditManagerContractName);
        default:
            throw new Error("Invalid creditManagerContractName");
    }
}

export function calcPrincipalDueForFullPeriods(
    unbilledPrincipal: BN,
    principalRateInBps: number,
    numPeriods: number,
): BN {
    return CONSTANTS.BP_FACTOR.pow(numPeriods)
        .sub(CONSTANTS.BP_FACTOR.sub(principalRateInBps).pow(numPeriods))
        .mul(unbilledPrincipal)
        .div(CONSTANTS.BP_FACTOR.pow(numPeriods));
}

export function calcPrincipalDueForPartialPeriod(
    unbilledPrincipal: BN,
    principalRateInBps: number,
    daysLeft: number | BN,
    totalDaysInFullPeriod: number | BN,
) {
    return unbilledPrincipal
        .mul(principalRateInBps)
        .mul(daysLeft)
        .div(CONSTANTS.BP_FACTOR.mul(totalDaysInFullPeriod));
}

export function calcYield(principal: BN, yieldInBps: BigNumberish, days: number): BN {
    return principal
        .mul(yieldInBps)
        .mul(days)
        .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.DAYS_IN_A_YEAR));
}

export interface AccruedIncomes {
    protocolIncome: BN;
    poolOwnerIncome: BN;
    eaIncome: BN;
}

export function calcPoolFees(
    profit: BN,
    protocolFeeInBps: number,
    rewardRateInBpsForPoolOwner: number,
    rewardRateInBpsForEA: number,
): [AccruedIncomes, BN] {
    const protocolIncome = profit.mul(protocolFeeInBps).div(CONSTANTS.BP_FACTOR);
    const remainingProfit = profit.sub(protocolIncome);
    const poolOwnerIncome = remainingProfit
        .mul(rewardRateInBpsForPoolOwner)
        .div(CONSTANTS.BP_FACTOR);
    const eaIncome = remainingProfit.mul(rewardRateInBpsForEA).div(CONSTANTS.BP_FACTOR);
    const accruedIncomes: AccruedIncomes = {
        protocolIncome,
        poolOwnerIncome,
        eaIncome,
    };
    return [accruedIncomes, remainingProfit.sub(poolOwnerIncome).sub(eaIncome)];
}

export async function checkRedemptionRecordByLender(
    trancheVaultContract: TrancheVault,
    lender: SignerWithAddress,
    nextEpochIdToProcess: BN | number,
    numSharesRequested: BN = BN.from(0),
    principalRequested: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    totalAmountWithdrawn: BN = BN.from(0),
    delta: number = 0,
) {
    const redemptionRecord = await trancheVaultContract.lenderRedemptionRecords(lender.address);
    checkRedemptionRecord(
        redemptionRecord,
        nextEpochIdToProcess,
        numSharesRequested,
        principalRequested,
        totalAmountProcessed,
        totalAmountWithdrawn,
        delta,
    );
}

type RedemptionRecordStructOutput = [BN, BN, BN, BN, BN] & {
    nextEpochIdToProcess: BN;
    numSharesRequested: BN;
    principalRequested: BN;
    totalAmountProcessed: BN;
    totalAmountWithdrawn: BN;
};

export function checkRedemptionRecord(
    redemptionRecord: RedemptionRecordStructOutput,
    nextEpochIdToProcess: BN | number,
    numSharesRequested: BN = BN.from(0),
    principalRequested: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    totalAmountWithdrawn: BN = BN.from(0),
    delta: number = 0,
) {
    expect(redemptionRecord.nextEpochIdToProcess).to.be.closeTo(nextEpochIdToProcess, delta);
    expect(redemptionRecord.numSharesRequested).to.be.closeTo(numSharesRequested, delta);
    expect(redemptionRecord.principalRequested).to.be.closeTo(principalRequested, delta);
    expect(redemptionRecord.totalAmountProcessed).to.be.closeTo(totalAmountProcessed, delta);
    expect(redemptionRecord.totalAmountWithdrawn).to.be.closeTo(totalAmountWithdrawn, delta);
}

export async function getAssetsAfterProfitAndLoss(
    poolConfigContract: PoolConfig,
    poolContract: Pool,
    firstLossCoverContracts: FirstLossCover[],
    poolOwner: SignerWithAddress,
    feeCalculator: FeeCalculator,
    profit: BN,
    loss: BN,
    lossRecovery: BN,
) {
    const adjustment = 8000;
    await overrideLPConfig(poolConfigContract, poolOwner, {
        tranchesRiskAdjustmentInBps: adjustment,
    });
    const assetInfo = await poolContract.tranchesAssets();
    const assets = [assetInfo[CONSTANTS.SENIOR_TRANCHE], assetInfo[CONSTANTS.JUNIOR_TRANCHE]];
    const profitAfterFees = await feeCalculator.calcPoolFeeDistribution(profit);
    const firstLossCoverInfos = await Promise.all(
        firstLossCoverContracts.map(
            async (contract) => await getFirstLossCoverInfo(contract, poolConfigContract),
        ),
    );

    return await PnLCalculator.calcRiskAdjustedProfitAndLoss(
        profitAfterFees,
        loss,
        lossRecovery,
        assets,
        [BN.from(0), BN.from(0)],
        BN.from(adjustment),
        firstLossCoverInfos,
    );
}
