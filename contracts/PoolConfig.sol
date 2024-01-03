// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AFFILIATE_FIRST_LOSS_COVER_INDEX, HUNDRED_PERCENT_IN_BPS, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";
import {PayPeriodDuration} from "./credit/CreditStructs.sol";

import "hardhat/console.sol";

struct PoolSettings {
    // The maximum credit line for a borrower in terms of the amount of poolTokens
    uint96 maxCreditLine;
    // The number of months in one pay period
    PayPeriodDuration payPeriodDuration;
    // The grace period before a late fee can be charged, in the unit of number of days
    uint8 latePaymentGracePeriodInDays;
    // The grace period before a default can be triggered, in days. This can be 0.
    uint16 defaultGracePeriodInDays;
    // Percentage (in basis points) of the receivable amount applied towards available credit
    // TODO same to advanceRateInBps?
    uint16 receivableRequiredInBps;
    // Specifies the max credit line as a percentage (in basis points) of the receivable amount.
    // E.g., for a receivable of $100 with an advance rate of 9000 bps, the credit line can be up to $90.
    uint16 advanceRateInBps;
    // TODO add comment here
    bool receivableAutoApproval;
}

/**
 * @notice Rewards and Responsibilities for various admins
 */
struct AdminRnR {
    // Percentage of pool income allocated to EA
    uint16 rewardRateInBpsForEA;
    // Percentage of pool income allocated to Pool Owner
    uint16 rewardRateInBpsForPoolOwner;
    // Percentage of the _liquidityCap to be contributed by EA
    uint16 liquidityRateInBpsByEA;
    // Percentage of the _liquidityCap to be contributed by Pool Owner
    uint16 liquidityRateInBpsByPoolOwner;
}

struct LPConfig {
    // whether approval is required for an LP to participate
    bool permissioned;
    // The max liquidity allowed for the pool.
    uint96 liquidityCap;
    // The upper bound of senior-to-junior ratio allowed
    uint8 maxSeniorJuniorRatio;
    // The fixed yield for senior tranche. Either this or tranchesRiskAdjustmentInBps is non-zero
    uint16 fixedSeniorYieldInBps;
    // Percentage of yield to be shifted from senior to junior. Either this or fixedSeniorYieldInBps is non-zero
    uint16 tranchesRiskAdjustmentInBps;
    // How long a lender has to wait after the last deposit before they can withdraw
    uint16 withdrawalLockoutPeriodInDays;
}

struct FrontLoadingFeesStructure {
    // Part of platform fee, charged as a flat amount when a borrow happens
    uint96 frontLoadingFeeFlat;
    // Part of platform fee, charged as a % of the borrowing amount when a borrow happens
    uint16 frontLoadingFeeBps;
}

struct FeeStructure {
    // Expected yield in basis points
    uint16 yieldInBps;
    // The min % of the outstanding principal to be paid in the statement for each each period
    uint16 minPrincipalRateInBps;
    // Part of late fee, charged as % of the totaling outstanding balance when a payment is late
    uint16 lateFeeBps;
}

struct FirstLossCoverConfig {
    // The percentage of loss to be paid by the first loss cover per occurrence of loss
    uint16 coverRatePerLossInBps;
    // The max amount that first loss cover can spend on one occurrence of loss
    uint96 coverCapPerLoss;
    // The max liquidity allowed for the first loss cover
    uint96 maxLiquidity;
    // The min liquidity required for the first loss cover
    uint96 minLiquidity;
    // Adjusts the yield of the first loss covers and junior tranche
    uint16 riskYieldMultiplierInBps;
}

interface ITrancheVaultLike {
    function totalAssetsOf(address account) external view returns (uint256 assets);
}

contract PoolConfig is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant POOL_OPERATOR_ROLE = keccak256("POOL_OPERATOR");

    //using SafeERC20 for IERC20;

    string public poolName;

    address public pool;
    address public poolSafe;
    address public seniorTranche;
    address public juniorTranche;
    address public tranchesPolicy;
    address public epochManager;
    address public poolFeeManager;
    address public calendar;

    address public creditDueManager;
    address public credit;
    address public creditManager;

    HumaConfig public humaConfig;

    // The ERC20 token this pool manages
    address public underlyingToken;

    // Evaluation Agents (EA) are the risk underwriting agents that associated with the pool.
    address public evaluationAgent;
    uint256 public evaluationAgentId;

    // The maximum number of first loss covers we allow is 16, which should be sufficient for now.
    address[16] internal _firstLossCovers;
    mapping(address => FirstLossCoverConfig) internal _firstLossCoverConfigs;

    PoolSettings internal _poolSettings;
    LPConfig internal _lpConfig;
    AdminRnR internal _adminRnR;
    FrontLoadingFeesStructure internal _frontFees;
    FeeStructure internal _feeStructure;

    // Address for the account that handles the treasury functions for the pool owner:
    // liquidity deposits, liquidity withdrawals, and reward withdrawals
    address public poolOwnerTreasury;

    address public receivableAsset;

    event EARewardsAndLiquidityChanged(
        uint256 rewardRate,
        uint256 liquidityRate,
        address indexed by
    );
    event EvaluationAgentChanged(address oldEA, address newEA, uint256 newEAId, address by);
    event PoolFeeManagerChanged(address poolFeeManager, address by);
    event HumaConfigChanged(address humaConfig, address by);

    event PoolChanged(address pool, address by);
    event PoolNameChanged(string name, address by);
    event PoolOwnerRewardsAndLiquidityChanged(
        uint256 rewardRate,
        uint256 liquidityRate,
        address indexed by
    );
    event PoolOwnerTreasuryChanged(address treasury, address indexed by);
    event PoolUnderlyingTokenChanged(address underlyingToken, address by);
    event TranchesChanged(address seniorTranche, address juniorTranche, address by);
    event PoolSafeChanged(address poolSafe, address by);
    event TranchesPolicyChanged(address tranchesPolicy, address by);
    event EpochManagerChanged(address epochManager, address by);
    event CreditChanged(address credit, address by);
    event FirstLossCoverChanged(
        uint8 index,
        address firstLossCover,
        uint16 coverRatePerLossInBps,
        uint96 coverCapPerLoss,
        uint96 maxLiquidity,
        uint96 minLiquidity,
        uint16 riskYieldMultiplierInBps,
        address by
    );
    event CalendarChanged(address calendar, address by);
    event ReceivableAssetChanged(address receivableAsset, address by);

    event PoolSettingsChanged(
        uint96 maxCreditLine,
        PayPeriodDuration payPeriodDuration,
        uint8 latePaymentGracePeriodInDays,
        uint16 defaultGracePeriodInDays,
        uint16 receivableRequiredInBps,
        uint16 advanceRateInBps,
        bool receivableAutoApproval,
        address by
    );

    event LPConfigChanged(
        bool permissioned,
        uint96 liquidityCap,
        uint8 maxSeniorJuniorRatio,
        uint16 fixedSeniorYieldInBps,
        uint16 tranchesRiskAdjustmentInBps,
        uint16 withdrawalLockoutInDays,
        address by
    );
    event FrontLoadingFeesChanged(
        uint96 frontLoadingFeeFlat,
        uint16 frontLoadingFeeBps,
        address by
    );
    event FeeStructureChanged(
        uint16 yieldInBps,
        uint16 minPrincipalRateInBps,
        uint16 lateFeeBps,
        address by
    );

    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the pool configuration
     * @param _poolName The name of the pool
     * @param _contracts The addresses of the contracts that are used by the pool
     *   _contracts[0]: address of HumaConfig
     *   _contracts[1]: address of underlyingToken
     *   _contracts[2]: address of calendar
     *   _contracts[3]: address of pool
     *   _contracts[4]: address of poolSafe
     *   _contracts[5]: address of poolFeeManager
     *   _contracts[6]: address of tranchesPolicy
     *   _contracts[7]: address of epochManager
     *   _contracts[8]: address of seniorTranche
     *   _contracts[9]: address of juniorTranche
     *   _contracts[10]: address of credit
     *   _contracts[11]: address of creditDueManager
     *   _contracts[12]: address of creditManager
     */

    function initialize(string memory _poolName, address[] memory _contracts) public initializer {
        poolName = _poolName;

        for (uint256 i = 0; i < _contracts.length; i++) {
            if (_contracts[i] == address(0)) revert Errors.zeroAddressProvided();
        }

        humaConfig = HumaConfig(_contracts[0]);
        address addr = _contracts[1];
        if (!humaConfig.isAssetValid(addr))
            revert Errors.underlyingTokenNotApprovedForHumaProtocol();
        underlyingToken = addr;
        calendar = _contracts[2];
        pool = _contracts[3];
        poolSafe = _contracts[4];
        poolFeeManager = _contracts[5];
        tranchesPolicy = _contracts[6];
        epochManager = _contracts[7];
        seniorTranche = _contracts[8];
        juniorTranche = _contracts[9];
        credit = _contracts[10];
        creditDueManager = _contracts[11];
        creditManager = _contracts[12];

        // Default values for the pool configurations. The pool owners are expected to reset
        // these values when setting up the pools. Setting these default values to avoid
        // strange behaviors when the pool owner missed setting up these configurations.
        PoolSettings memory tempPoolSettings = _poolSettings;
        tempPoolSettings.payPeriodDuration = PayPeriodDuration.Monthly;
        tempPoolSettings.receivableRequiredInBps = 10000; // 100%
        tempPoolSettings.advanceRateInBps = 8000; // 80%
        tempPoolSettings.latePaymentGracePeriodInDays = 5;
        tempPoolSettings.defaultGracePeriodInDays = 10; // 10 days
        _poolSettings = tempPoolSettings;

        AdminRnR memory adminRnRConfig = _adminRnR;
        adminRnRConfig.rewardRateInBpsForEA = 300; // 3%
        adminRnRConfig.rewardRateInBpsForPoolOwner = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByEA = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByPoolOwner = 200; // 2%
        _adminRnR = adminRnRConfig;

        LPConfig memory config = _lpConfig;
        config.maxSeniorJuniorRatio = 4; // senior : junior = 4:1
        _lpConfig = config;
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function setPoolOwnerRewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForEA > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.adminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForPoolOwner = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByPoolOwner = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit PoolOwnerRewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    function setEARewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForPoolOwner > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.adminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForEA = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByEA = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit EARewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    /**
     * @notice Adds an evaluation agent to the list who can approve loans.
     * @param agent the evaluation agent to be added
     */
    function setEvaluationAgent(uint256 eaId, address agent) external {
        if (agent == address(0)) revert Errors.zeroAddressProvided();
        _onlyOwnerOrHumaMasterAdmin();

        if (IERC721(humaConfig.eaNFTContractAddress()).ownerOf(eaId) != agent)
            revert Errors.proposedEADoesNotOwnProvidedEANFT();

        // Transfer the accrued EA income to the old EA's wallet.
        // Decided not to check if there is enough balance in the pool. If there is
        // not enough balance, the transaction will fail. PoolOwner has to find enough
        // liquidity to pay the EA before replacing it.
        address oldEA = evaluationAgent;
        if (oldEA != address(0)) {
            IPoolFeeManager feeManager = IPoolFeeManager(poolFeeManager);
            (, , uint256 eaWithdrawable) = feeManager.getWithdrawables();
            feeManager.withdrawEAFee(eaWithdrawable);
        }

        // Make sure the new EA meets the liquidity requirements.
        if (IPool(pool).isPoolOn()) {
            if (
                !IFirstLossCover(_firstLossCovers[AFFILIATE_FIRST_LOSS_COVER_INDEX]).isSufficient()
            ) {
                revert Errors.lessThanRequiredCover();
            }
            ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
            checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(agent));
        }

        evaluationAgent = agent;
        evaluationAgentId = eaId;

        emit EvaluationAgentChanged(oldEA, agent, eaId, msg.sender);
    }

    function setPoolFeeManager(address _poolFeeManager) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolFeeManager == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = _poolFeeManager;
        emit PoolFeeManagerChanged(_poolFeeManager, msg.sender);
    }

    function setHumaConfig(address _humaConfig) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_humaConfig == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(_humaConfig);
        emit HumaConfigChanged(_humaConfig, msg.sender);
    }

    function setPool(address _pool) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_pool == address(0)) revert Errors.zeroAddressProvided();
        pool = _pool;
        emit PoolChanged(_pool, msg.sender);
    }

    /**
     * @notice Change pool name
     */
    function setPoolName(string memory newName) external {
        _onlyOwnerOrHumaMasterAdmin();
        poolName = newName;
        emit PoolNameChanged(newName, msg.sender);
    }

    function setPoolOwnerTreasury(address _poolOwnerTreasury) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolOwnerTreasury == address(0)) revert Errors.zeroAddressProvided();
        poolOwnerTreasury = _poolOwnerTreasury;
        emit PoolOwnerTreasuryChanged(_poolOwnerTreasury, msg.sender);
    }

    function setPoolUnderlyingToken(address _underlyingToken) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_underlyingToken == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = _underlyingToken;
        emit PoolUnderlyingTokenChanged(_underlyingToken, msg.sender);
    }

    function setTranches(address _seniorTranche, address _juniorTranche) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_seniorTranche == address(0) || _juniorTranche == address(0))
            revert Errors.zeroAddressProvided();
        seniorTranche = _seniorTranche;
        juniorTranche = _juniorTranche;
        emit TranchesChanged(_seniorTranche, _juniorTranche, msg.sender);
    }

    function setPoolSafe(address _poolSafe) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolSafe == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = _poolSafe;
        emit PoolSafeChanged(poolSafe, msg.sender);
    }

    function setTranchesPolicy(address _tranchesPolicy) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_tranchesPolicy == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = _tranchesPolicy;
        emit TranchesPolicyChanged(_tranchesPolicy, msg.sender);
    }

    function setEpochManager(address _epochManager) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_epochManager == address(0)) revert Errors.zeroAddressProvided();
        epochManager = _epochManager;
        emit EpochManagerChanged(epochManager, msg.sender);
    }

    function setCredit(address _credit) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_credit == address(0)) revert Errors.zeroAddressProvided();
        credit = _credit;
        emit CreditChanged(_credit, msg.sender);
    }

    //* todo passing the parameter inside the struct instead of the struct itself.
    function setFirstLossCover(
        uint8 index,
        address firstLossCover,
        FirstLossCoverConfig memory config
    ) external {
        _onlyOwnerOrHumaMasterAdmin();
        _firstLossCovers[index] = firstLossCover;
        _firstLossCoverConfigs[firstLossCover] = config;

        emit FirstLossCoverChanged(
            index,
            firstLossCover,
            config.coverRatePerLossInBps,
            config.coverCapPerLoss,
            config.maxLiquidity,
            config.minLiquidity,
            config.riskYieldMultiplierInBps,
            msg.sender
        );
    }

    function setCalendar(address _calendar) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_calendar == address(0)) revert Errors.zeroAddressProvided();
        calendar = _calendar;
        emit CalendarChanged(_calendar, msg.sender);
    }

    function setReceivableAsset(address _receivableAsset) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_receivableAsset == address(0)) revert Errors.zeroAddressProvided();
        receivableAsset = _receivableAsset;
        emit ReceivableAssetChanged(_receivableAsset, msg.sender);
    }

    function setPoolSettings(PoolSettings memory settings) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (settings.advanceRateInBps > 10000) {
            revert Errors.invalidBasisPointHigherThan10000();
        }
        _poolSettings = settings;
        emit PoolSettingsChanged(
            settings.maxCreditLine,
            settings.payPeriodDuration,
            settings.latePaymentGracePeriodInDays,
            settings.defaultGracePeriodInDays,
            settings.receivableRequiredInBps,
            settings.advanceRateInBps,
            settings.receivableAutoApproval,
            msg.sender
        );
    }

    function setLPConfig(LPConfig memory lpConfig) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (lpConfig.fixedSeniorYieldInBps != _lpConfig.fixedSeniorYieldInBps) {
            ITranchesPolicy(tranchesPolicy).refreshYieldTracker(
                IPool(pool).currentTranchesAssets()
            );
        }
        _lpConfig = lpConfig;
        emit LPConfigChanged(
            lpConfig.permissioned,
            lpConfig.liquidityCap,
            lpConfig.maxSeniorJuniorRatio,
            lpConfig.fixedSeniorYieldInBps,
            lpConfig.tranchesRiskAdjustmentInBps,
            lpConfig.withdrawalLockoutPeriodInDays,
            msg.sender
        );
    }

    function setFrontLoadingFees(FrontLoadingFeesStructure memory frontFees) external {
        _onlyOwnerOrHumaMasterAdmin();
        _frontFees = frontFees;
        emit FrontLoadingFeesChanged(
            frontFees.frontLoadingFeeFlat,
            frontFees.frontLoadingFeeBps,
            msg.sender
        );
    }

    function setFeeStructure(FeeStructure memory feeStructure) external {
        _onlyOwnerOrHumaMasterAdmin();
        _feeStructure = feeStructure;
        emit FeeStructureChanged(
            feeStructure.yieldInBps,
            feeStructure.minPrincipalRateInBps,
            feeStructure.lateFeeBps,
            msg.sender
        );
    }

    /**
     * @notice Checks whether the affiliate first loss cover has met the liquidity requirements.
     */
    function checkFirstLossCoverRequirementsForAdmin() public view {
        IFirstLossCover firstLossCover = IFirstLossCover(
            _firstLossCovers[AFFILIATE_FIRST_LOSS_COVER_INDEX]
        );
        if (!firstLossCover.isSufficient()) revert Errors.lessThanRequiredCover();
    }

    function checkLiquidityRequirementForPoolOwner(uint256 balance) public view {
        if (balance < _getRequiredLiquidityForPoolOwner())
            revert Errors.poolOwnerNotEnoughLiquidity();
    }

    function checkLiquidityRequirementForEA(uint256 balance) public view {
        if (balance < _getRequiredLiquidityForEA())
            revert Errors.evaluationAgentNotEnoughLiquidity();
    }

    /**
     * @notice Checks whether both the EA and the pool owner treasury have met the pool's liquidity requirements
     */
    function checkLiquidityRequirements() public view {
        ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
        checkLiquidityRequirementForPoolOwner(juniorTrancheVault.totalAssetsOf(poolOwnerTreasury));
        if (evaluationAgent != address(0)) {
            checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(evaluationAgent));
        }
    }

    /**
     * @notice Checks whether the lender can still meet the liquidity requirements after redemption.
     * @param lender The lender address
     * @param trancheVault The tranche vault address
     * @param newBalance The resulting balance of the lender after redemption
     */
    function checkLiquidityRequirementForRedemption(
        address lender,
        address trancheVault,
        uint256 newBalance
    ) public view {
        if (trancheVault != juniorTranche) {
            // There is no liquidity requirement for the senior tranche.
            return;
        }
        if (lender == poolOwnerTreasury) {
            checkLiquidityRequirementForPoolOwner(newBalance);
        }
        if (lender == evaluationAgent) {
            checkLiquidityRequirementForEA(newBalance);
        }
    }

    function getLPConfig() external view returns (LPConfig memory) {
        return _lpConfig;
    }

    function getAdminRnR() external view returns (AdminRnR memory) {
        return _adminRnR;
    }

    function getFirstLossCovers() external view returns (address[16] memory) {
        return _firstLossCovers;
    }

    function getFirstLossCover(uint256 index) external view returns (address) {
        return _firstLossCovers[index];
    }

    function isFirstLossCover(address account) external view returns (bool isCover) {
        uint256 numCovers = _firstLossCovers.length;
        for (uint256 i = 0; i < numCovers; i++) {
            if (account == address(_firstLossCovers[i])) return true;
        }
        return false;
    }

    function getFirstLossCoverConfig(
        address firstLossCover
    ) external view returns (FirstLossCoverConfig memory) {
        return _firstLossCoverConfigs[firstLossCover];
    }

    function getPoolSettings() external view returns (PoolSettings memory) {
        return _poolSettings;
    }

    function getFrontLoadingFees() external view returns (uint256, uint256) {
        return (_frontFees.frontLoadingFeeFlat, _frontFees.frontLoadingFeeBps);
    }

    function getFeeStructure() external view returns (FeeStructure memory) {
        return _feeStructure;
    }

    function onlyPoolOwner(address account) public view {
        // Treat DEFAULT_ADMIN_ROLE role as owner role
        if (!hasRole(DEFAULT_ADMIN_ROLE, account)) revert Errors.notPoolOwner();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or PDS service.
     */
    function onlyPoolOwnerOrPDSServiceAccount(address account) public view {
        // Treat DEFAULT_ADMIN_ROLE role as owner role
        if (!hasRole(DEFAULT_ADMIN_ROLE, account) && account != humaConfig.pdsServiceAccount())
            revert Errors.notAuthorizedCaller();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or EA.
     */
    function onlyPoolOwnerOrEA(address account) public view returns (address) {
        if (
            !hasRole(DEFAULT_ADMIN_ROLE, account) &&
            account != evaluationAgent &&
            account != address(this)
        ) revert Errors.notPoolOwnerOrEA();
        return evaluationAgent;
    }

    /**
     * @notice Allow for sensitive pool functions only to be called by
     * the pool owner and the huma master admin
     */
    function onlyOwnerOrHumaMasterAdmin(address account) public view {
        if (!hasRole(DEFAULT_ADMIN_ROLE, account) && account != humaConfig.owner()) {
            revert Errors.permissionDeniedNotAdmin();
        }
    }

    function onlyHumaMasterAdmin(address account) public view {
        if (account != humaConfig.owner()) {
            revert Errors.permissionDeniedNotAdmin();
        }
    }

    function onlyPool(address account) external view {
        if (account != pool) revert Errors.notPool();
    }

    function onlyProtocolAndPoolOn() external view {
        if (humaConfig.paused()) revert Errors.protocolIsPaused();
        if (!IPool(pool).isPoolOn()) revert Errors.poolIsNotOn();
    }

    function onlyPoolOperator(address account) external view {
        if (!hasRole(POOL_OPERATOR_ROLE, account)) revert Errors.poolOperatorRequired();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or Huma protocol owner
     */
    function _onlyOwnerOrHumaMasterAdmin() internal view {
        onlyOwnerOrHumaMasterAdmin(msg.sender);
    }

    function _getRequiredLiquidityForPoolOwner() internal view returns (uint256 amount) {
        return
            (_lpConfig.liquidityCap * _adminRnR.liquidityRateInBpsByPoolOwner) /
            HUNDRED_PERCENT_IN_BPS;
    }

    function _getRequiredLiquidityForEA() internal view returns (uint256 amount) {
        return
            (_lpConfig.liquidityCap * _adminRnR.liquidityRateInBpsByEA) / HUNDRED_PERCENT_IN_BPS;
    }

    function _authorizeUpgrade(address) internal view override {
        onlyHumaMasterAdmin(msg.sender);
    }
}
