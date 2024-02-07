// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {IPoolFeeManager} from "../liquidity/interfaces/IPoolFeeManager.sol";
import {IPool} from "../liquidity/interfaces/IPool.sol";
import {IFirstLossCover} from "../liquidity/interfaces/IFirstLossCover.sol";
import {ITranchesPolicy} from "../liquidity/interfaces/ITranchesPolicy.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ADMIN_LOSS_COVER_INDEX, HUNDRED_PERCENT_IN_BPS, PayPeriodDuration} from "./SharedDefs.sol";
import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

struct PoolSettings {
    // The maximum credit line for a borrower in terms of the amount of poolTokens
    uint96 maxCreditLine;
    // The minimum amount a lender/First Loss Cover provider needs to supply each time they deposit.
    // This is also the absolute minimum balance the pool owner needs to maintain in tranches to prevent
    // inflation attacks.
    uint96 minDepositAmount;
    // The number of months in one pay period
    PayPeriodDuration payPeriodDuration;
    // The grace period before a late fee can be charged, in the unit of number of days
    uint8 latePaymentGracePeriodInDays;
    // The grace period before a default can be triggered, in days. This can be 0.
    uint16 defaultGracePeriodInDays;
    // Specifies the max credit line as a percentage (in basis points) of the receivable amount.
    // E.g., for a receivable of $100 with an advance rate of 9000 bps, the credit line can be up to $90.
    uint16 advanceRateInBps;
    // Specifies whether receivables should be automatically approved during initial drawdown. If `false`, then
    // receivables need to be approved prior to the first drawdown.
    bool receivableAutoApproval;
}

/**
 * @notice Rewards and Responsibilities for various admins.
 */
struct AdminRnR {
    // Percentage of pool income allocated to EA
    uint16 rewardRateInBpsForEA;
    // Percentage of pool income allocated to Pool Owner
    uint16 rewardRateInBpsForPoolOwner;
    // Percentage of the liquidityCap to be contributed by EA in the junior tranche.
    uint16 liquidityRateInBpsByEA;
    // Percentage of the liquidityCap to be contributed by Pool Owner in the junior tranche.
    uint16 liquidityRateInBpsByPoolOwner;
}

struct LPConfig {
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
    // The late fee rate expressed in bps. The late fee is the additional charge on top of the yield
    // when a payment is late, and is calculated as a % of the total outstanding balance.
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
    /// The smallest value that `PoolSettings.minDepositAmount` can be set to. Note that this value is "pre-decimals",
    /// i.e. if the underlying token is USDC, then this represents $10 in USDC.
    uint256 private constant MIN_DEPOSIT_AMOUNT_THRESHOLD = 10;

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

    /// The ERC20 token this pool manages.
    address public underlyingToken;

    /// Evaluation Agents (EA) are the risk underwriting agents that associated with the pool.
    address public evaluationAgent;
    uint256 public evaluationAgentId;

    /// The maximum number of first loss covers we allow is 16, which should be sufficient for now.
    address[16] internal _firstLossCovers;
    mapping(address => FirstLossCoverConfig) internal _firstLossCoverConfigs;

    PoolSettings internal _poolSettings;
    LPConfig internal _lpConfig;
    AdminRnR internal _adminRnR;
    FrontLoadingFeesStructure internal _frontFees;
    FeeStructure internal _feeStructure;

    /// Address for the account that handles the treasury functions for the pool owner:
    /// liquidity deposits, liquidity withdrawals, and reward withdrawals.
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
    event CreditDueManagerChanged(address creditDueManager, address by);
    event CreditChanged(address credit, address by);
    event CreditManagerChanged(address creditManager, address by);
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
        uint96 minDepositAmount,
        PayPeriodDuration payPeriodDuration,
        uint8 latePaymentGracePeriodInDays,
        uint16 defaultGracePeriodInDays,
        uint16 advanceRateInBps,
        bool receivableAutoApproval,
        address by
    );

    event LPConfigChanged(
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
     * @notice Initialize the pool configuration.
     * @param _poolName The name of the pool.
     * @param _contracts The addresses of the contracts that are used by the pool.
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
    function initialize(
        string memory _poolName,
        address[] memory _contracts
    ) external initializer {
        poolName = _poolName;

        for (uint256 i = 0; i < _contracts.length; i++) {
            if (_contracts[i] == address(0)) revert Errors.ZeroAddressProvided();
        }

        humaConfig = HumaConfig(_contracts[0]);
        address addr = _contracts[1];
        if (!humaConfig.isAssetValid(addr))
            revert Errors.UnderlyingTokenNotApprovedForHumaProtocol();
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
        tempPoolSettings.minDepositAmount = uint96(
            MIN_DEPOSIT_AMOUNT_THRESHOLD * 10 ** IERC20Metadata(underlyingToken).decimals()
        );
        tempPoolSettings.payPeriodDuration = PayPeriodDuration.Monthly;
        tempPoolSettings.advanceRateInBps = 8000; // 80%
        tempPoolSettings.latePaymentGracePeriodInDays = 5;
        _poolSettings = tempPoolSettings;

        AdminRnR memory adminRnRConfig = _adminRnR;
        adminRnRConfig.rewardRateInBpsForEA = 300; // 3%
        adminRnRConfig.rewardRateInBpsForPoolOwner = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByEA = 200; // 2%
        adminRnRConfig.liquidityRateInBpsByPoolOwner = 200; // 2%
        _adminRnR = adminRnRConfig;

        LPConfig memory lpConfig = _lpConfig;
        lpConfig.maxSeniorJuniorRatio = 4; // senior : junior = 4:1
        lpConfig.withdrawalLockoutPeriodInDays = 90;
        _lpConfig = lpConfig;

        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolOwnerRewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyPoolOwnerOrHumaOwner();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForEA > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.AdminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForPoolOwner = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByPoolOwner = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit PoolOwnerRewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setEARewardsAndLiquidity(uint256 rewardRate, uint256 liquidityRate) external {
        _onlyPoolOwnerOrHumaOwner();
        if (rewardRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();
        AdminRnR memory tempAdminRnR = _adminRnR;
        if (rewardRate + tempAdminRnR.rewardRateInBpsForPoolOwner > HUNDRED_PERCENT_IN_BPS) {
            // Since we split the profit between the pool owner and EA, their combined reward rate cannot exceed 100%.
            revert Errors.AdminRewardRateTooHigh();
        }

        tempAdminRnR.rewardRateInBpsForEA = uint16(rewardRate);
        tempAdminRnR.liquidityRateInBpsByEA = uint16(liquidityRate);
        _adminRnR = tempAdminRnR;
        emit EARewardsAndLiquidityChanged(rewardRate, liquidityRate, msg.sender);
    }

    /**
     * @notice Adds an Evaluation Agent to the list who can approve loans.
     * @param agent The Evaluation Agent to be added.
     * @custom:access Only the pool owner and the Huma owner can call this function.
     */
    function setEvaluationAgent(uint256 eaId, address agent) external {
        if (agent == address(0)) revert Errors.ZeroAddressProvided();
        _onlyPoolOwnerOrHumaOwner();

        if (IERC721(humaConfig.eaNFTContractAddress()).ownerOf(eaId) != agent)
            revert Errors.ProposedEADoesNotOwnProvidedEANFT();

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
            if (!IFirstLossCover(_firstLossCovers[ADMIN_LOSS_COVER_INDEX]).isSufficient()) {
                revert Errors.InsufficientFirstLossCover();
            }
            ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
            _checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(agent));
        }

        evaluationAgent = agent;
        evaluationAgentId = eaId;

        emit EvaluationAgentChanged(oldEA, agent, eaId, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolFeeManager(address _poolFeeManager) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_poolFeeManager == address(0)) revert Errors.ZeroAddressProvided();
        poolFeeManager = _poolFeeManager;
        emit PoolFeeManagerChanged(_poolFeeManager, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setHumaConfig(address _humaConfig) external {
        onlyHumaOwner(msg.sender);
        if (_humaConfig == address(0)) revert Errors.ZeroAddressProvided();
        humaConfig = HumaConfig(_humaConfig);
        emit HumaConfigChanged(_humaConfig, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPool(address _pool) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_pool == address(0)) revert Errors.ZeroAddressProvided();
        pool = _pool;
        emit PoolChanged(_pool, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolName(string memory newName) external {
        _onlyPoolOwnerOrHumaOwner();
        poolName = newName;
        emit PoolNameChanged(newName, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolOwnerTreasury(address _poolOwnerTreasury) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_poolOwnerTreasury == address(0)) revert Errors.ZeroAddressProvided();
        poolOwnerTreasury = _poolOwnerTreasury;
        emit PoolOwnerTreasuryChanged(_poolOwnerTreasury, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setTranches(address _seniorTranche, address _juniorTranche) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_seniorTranche == address(0) || _juniorTranche == address(0))
            revert Errors.ZeroAddressProvided();
        seniorTranche = _seniorTranche;
        juniorTranche = _juniorTranche;
        emit TranchesChanged(_seniorTranche, _juniorTranche, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolSafe(address _poolSafe) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_poolSafe == address(0)) revert Errors.ZeroAddressProvided();
        poolSafe = _poolSafe;
        emit PoolSafeChanged(poolSafe, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setTranchesPolicy(address _tranchesPolicy) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_tranchesPolicy == address(0)) revert Errors.ZeroAddressProvided();
        tranchesPolicy = _tranchesPolicy;
        emit TranchesPolicyChanged(_tranchesPolicy, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setEpochManager(address _epochManager) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_epochManager == address(0)) revert Errors.ZeroAddressProvided();
        epochManager = _epochManager;
        emit EpochManagerChanged(epochManager, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCreditDueManager(address creditDueManager_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (creditDueManager_ == address(0)) revert Errors.ZeroAddressProvided();
        creditDueManager = creditDueManager_;
        emit CreditDueManagerChanged(creditDueManager_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCredit(address _credit) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_credit == address(0)) revert Errors.ZeroAddressProvided();
        credit = _credit;
        emit CreditChanged(_credit, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCreditManager(address creditManager_) external {
        _onlyPoolOwnerOrHumaOwner();
        if (creditManager_ == address(0)) revert Errors.ZeroAddressProvided();
        creditManager = creditManager_;
        emit CreditManagerChanged(creditManager_, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setFirstLossCover(
        uint8 index,
        address firstLossCover,
        FirstLossCoverConfig memory config
    ) external {
        _onlyPoolOwnerOrHumaOwner();
        if (config.coverRatePerLossInBps > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();

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

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setCalendar(address _calendar) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_calendar == address(0)) revert Errors.ZeroAddressProvided();
        calendar = _calendar;
        emit CalendarChanged(_calendar, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setReceivableAsset(address _receivableAsset) external {
        _onlyPoolOwnerOrHumaOwner();
        if (_receivableAsset == address(0)) revert Errors.ZeroAddressProvided();
        receivableAsset = _receivableAsset;
        emit ReceivableAssetChanged(_receivableAsset, msg.sender);
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setPoolSettings(PoolSettings memory settings) external {
        _onlyPoolOwnerOrHumaOwner();
        if (
            settings.minDepositAmount <
            uint96(MIN_DEPOSIT_AMOUNT_THRESHOLD * 10 ** IERC20Metadata(underlyingToken).decimals())
        ) {
            revert Errors.MinDepositAmountTooLow();
        }
        if (
            settings.latePaymentGracePeriodInDays >=
            ICalendar(calendar).getTotalDaysInFullPeriod(settings.payPeriodDuration)
        ) {
            revert Errors.LatePaymentGracePeriodTooLong();
        }
        if (settings.advanceRateInBps > HUNDRED_PERCENT_IN_BPS) {
            revert Errors.InvalidBasisPointHigherThan10000();
        }
        _poolSettings = settings;
        emit PoolSettingsChanged(
            settings.maxCreditLine,
            settings.minDepositAmount,
            settings.payPeriodDuration,
            settings.latePaymentGracePeriodInDays,
            settings.defaultGracePeriodInDays,
            settings.advanceRateInBps,
            settings.receivableAutoApproval,
            msg.sender
        );
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setLPConfig(LPConfig memory lpConfig) external {
        _onlyPoolOwnerOrHumaOwner();
        if (
            lpConfig.fixedSeniorYieldInBps > HUNDRED_PERCENT_IN_BPS ||
            lpConfig.tranchesRiskAdjustmentInBps > HUNDRED_PERCENT_IN_BPS
        ) revert Errors.InvalidBasisPointHigherThan10000();
        if (lpConfig.fixedSeniorYieldInBps != _lpConfig.fixedSeniorYieldInBps) {
            ITranchesPolicy(tranchesPolicy).refreshYieldTracker(
                IPool(pool).currentTranchesAssets()
            );
        }
        _lpConfig = lpConfig;
        emit LPConfigChanged(
            lpConfig.liquidityCap,
            lpConfig.maxSeniorJuniorRatio,
            lpConfig.fixedSeniorYieldInBps,
            lpConfig.tranchesRiskAdjustmentInBps,
            lpConfig.withdrawalLockoutPeriodInDays,
            msg.sender
        );
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setFrontLoadingFees(FrontLoadingFeesStructure memory frontFees) external {
        _onlyPoolOwnerOrHumaOwner();
        if (frontFees.frontLoadingFeeBps > HUNDRED_PERCENT_IN_BPS)
            revert Errors.InvalidBasisPointHigherThan10000();

        _frontFees = frontFees;
        emit FrontLoadingFeesChanged(
            frontFees.frontLoadingFeeFlat,
            frontFees.frontLoadingFeeBps,
            msg.sender
        );
    }

    /// @custom:access Only the pool owner and the Huma owner can call this function.
    function setFeeStructure(FeeStructure memory feeStructure) external {
        _onlyPoolOwnerOrHumaOwner();
        if (
            feeStructure.minPrincipalRateInBps > HUNDRED_PERCENT_IN_BPS ||
            feeStructure.lateFeeBps > HUNDRED_PERCENT_IN_BPS
        ) revert Errors.InvalidBasisPointHigherThan10000();

        _feeStructure = feeStructure;
        emit FeeStructureChanged(
            feeStructure.yieldInBps,
            feeStructure.minPrincipalRateInBps,
            feeStructure.lateFeeBps,
            msg.sender
        );
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

    function onlyPool(address account) external view {
        if (account != pool) revert Errors.AuthorizedContractCallerRequired();
    }

    function onlyProtocolAndPoolOn() external view {
        if (humaConfig.paused()) revert Errors.ProtocolIsPaused();
        if (!IPool(pool).isPoolOn()) revert Errors.PoolIsNotOn();
    }

    function onlyPoolOperator(address account) external view {
        if (!hasRole(POOL_OPERATOR_ROLE, account)) revert Errors.PoolOperatorRequired();
    }

    /**
     * @notice Checks whether the admin first loss cover has met the liquidity requirements.
     */
    function checkFirstLossCoverRequirementsForAdmin() external view {
        IFirstLossCover firstLossCover = IFirstLossCover(_firstLossCovers[ADMIN_LOSS_COVER_INDEX]);
        if (!firstLossCover.isSufficient()) revert Errors.InsufficientFirstLossCover();
    }

    /**
     * @notice Checks whether both the EA and the pool owner treasury have met the pool's liquidity requirements
     */
    function checkLiquidityRequirements() external view {
        ITrancheVaultLike juniorTrancheVault = ITrancheVaultLike(juniorTranche);
        // Pool owner needs to satisfy the liquidity requirements for both the junior and senior tranches.
        _checkLiquidityRequirementForPoolOwner(
            juniorTranche,
            juniorTrancheVault.totalAssetsOf(poolOwnerTreasury)
        );
        _checkLiquidityRequirementForPoolOwner(
            seniorTranche,
            ITrancheVaultLike(seniorTranche).totalAssetsOf(poolOwnerTreasury)
        );

        if (evaluationAgent != address(0)) {
            // EA only needs to satisfy the liquidity requirement in the junior tranche.
            _checkLiquidityRequirementForEA(juniorTrancheVault.totalAssetsOf(evaluationAgent));
        }
    }

    /**
     * @notice Checks whether the lender can still meet the liquidity requirements after redemption.
     * @param lender The lender address.
     * @param trancheVault The tranche vault address.
     * @param newBalance The resulting balance of the lender after redemption.
     */
    function checkLiquidityRequirementForRedemption(
        address lender,
        address trancheVault,
        uint256 newBalance
    ) external view {
        if (lender == poolOwnerTreasury) {
            // The pool owner needs to satisfy the liquidity requirement in both tranches.
            _checkLiquidityRequirementForPoolOwner(trancheVault, newBalance);
        }
        if (lender == evaluationAgent && trancheVault == juniorTranche) {
            // EA is only required to participate in the junior tranche.
            _checkLiquidityRequirementForEA(newBalance);
        }
    }

    function onlyPoolOwner(address account) public view {
        // Treat DEFAULT_ADMIN_ROLE role as owner role
        if (!hasRole(DEFAULT_ADMIN_ROLE, account)) revert Errors.PoolOwnerRequired();
    }

    /**
     * @notice "Modifier" function that limits access to the pool owner or the Sentinel Service account.
     */
    function onlyPoolOwnerOrSentinelServiceAccount(address account) public view {
        // Treat DEFAULT_ADMIN_ROLE role as owner role
        if (
            !hasRole(DEFAULT_ADMIN_ROLE, account) && account != humaConfig.sentinelServiceAccount()
        ) revert Errors.AuthorizedContractCallerRequired();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or EA.
     */
    function onlyPoolOwnerOrEA(address account) public view returns (address) {
        if (
            !hasRole(DEFAULT_ADMIN_ROLE, account) &&
            account != evaluationAgent &&
            account != address(this)
        ) revert Errors.PoolOwnerOrEARequired();
        return evaluationAgent;
    }

    /**
     * @notice Allow for sensitive pool functions only to be called by
     * the pool owner and the huma owner.
     */
    function onlyPoolOwnerOrHumaOwner(address account) public view {
        if (!hasRole(DEFAULT_ADMIN_ROLE, account) && account != humaConfig.owner()) {
            revert Errors.PoolOwnerOrHumaOwnerRequired();
        }
    }

    function onlyHumaOwner(address account) public view {
        if (account != humaConfig.owner()) {
            revert Errors.HumaOwnerRequired();
        }
    }

    function _checkLiquidityRequirementForPoolOwner(
        address tranche,
        uint256 balance
    ) internal view {
        uint256 minDepositAmount = _poolSettings.minDepositAmount;
        if (tranche == juniorTranche) {
            // For the junior tranche, the pool owner's liquidity must be higher than both the
            // absolute asset threshold and the the relative threshold determined by the pool liquidity cap.
            uint256 minRelativeBalance = (_lpConfig.liquidityCap *
                _adminRnR.liquidityRateInBpsByPoolOwner) / HUNDRED_PERCENT_IN_BPS;
            if (balance < Math.max(minDepositAmount, minRelativeBalance)) {
                revert Errors.PoolOwnerInsufficientLiquidity();
            }
        }
        if (
            tranche == seniorTranche &&
            _lpConfig.maxSeniorJuniorRatio > 0 &&
            balance < minDepositAmount
        ) {
            // If the `maxSeniorJuniorRatio` is 0, then the senior tranche is disabled, thus the pool owner
            // does not have to deposit liquidity. Otherwise, the pool owner must maintain a balance of at least
            // `minDepositAmount` to prevent inflation attacks.
            revert Errors.PoolOwnerInsufficientLiquidity();
        }
    }

    function _checkLiquidityRequirementForEA(uint256 balance) internal view {
        uint256 minLiquidityRequirement = (_lpConfig.liquidityCap *
            _adminRnR.liquidityRateInBpsByEA) / HUNDRED_PERCENT_IN_BPS;
        if (balance < minLiquidityRequirement)
            revert Errors.EvaluationAgentInsufficientLiquidity();
    }

    /**
     * @notice "Modifier" function that limits access to pool owner or Huma protocol owner.
     */
    function _onlyPoolOwnerOrHumaOwner() internal view {
        onlyPoolOwnerOrHumaOwner(msg.sender);
    }

    function _authorizeUpgrade(address) internal view override {
        onlyHumaOwner(msg.sender);
    }
}
