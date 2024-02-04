// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolConfig, FirstLossCoverConfig, PoolSettings} from "../common/PoolConfig.sol";
import {PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure} from "../common/PoolConfig.sol";
import {Errors} from "../common/Errors.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {LibTimelockController} from "./library/LibTimelockController.sol";

interface IPoolConfigCacheLike {
    function initialize(address poolConfig) external;
}

interface IVaultLike {
    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external;
}

contract PoolFactory is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    /**
     * @notice Represents the status of a pool for bookkeeping
     */
    enum PoolStatus {
        Created, // the pool is created but not initialized yet
        Initialized, // the pool is initialized and ready for use
        Closed // the pool is closed and not in operation anymore
    }

    // Struct to store information about a pool
    struct PoolRecord {
        uint256 poolId;
        address poolAddress;
        string poolName;
        PoolStatus poolStatus;
        address poolConfigAddress;
        address poolTimelock;
    }

    // only deployer can create new pools
    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    // poolId
    uint256 public poolId;

    // protocol and implementation addresses
    address public humaConfigAddress;
    address public calendarAddress;
    address public fixedSeniorYieldTranchesPolicyImplAddress;
    address public riskAdjustedTranchesPolicyImplAddress;

    // Credit implementation addresses
    address public creditLineImplAddress;
    address public receivableBackedCreditLineImplAddress;
    address public receivableFactoringCreditImplAddress;
    address public creditLineManagerImplAddress;
    address public receivableBackedCreditLineManagerImplAddress;
    address public receivableFactoringCreditManagerImplAddress;

    // pool implementation addresses
    address public poolConfigImplAddress;
    address public poolFeeManagerImplAddress;
    address public poolImplAddress;
    address public poolSafeImplAddress;
    address public firstLossCoverImplAddress;
    address public epochManagerImplAddress;
    address public trancheVaultImplAddress;
    address public creditDueManagerImplAddress;

    // huma implementation of receivable
    address public receivableImpl;

    // poolId => PoolRecord
    mapping(uint256 poolId => PoolRecord record) private _pools;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;

    // events for implementation address changes
    event PoolConfigImplChanged(address oldAddress, address newAddress);
    event PoolFeeManagerImplChanged(address oldAddress, address newAddress);
    event PoolImplChanged(address oldAddress, address newAddress);
    event PoolSafeImplChanged(address oldAddress, address newAddress);
    event FirstLossCoverImplChanged(address oldAddress, address newAddress);
    event TranchesPolicyImplChanged(address oldAddress, address newAddress);
    event EpochManagerImplChanged(address oldAddress, address newAddress);
    event TrancheVaultImplChanged(address oldAddress, address newAddress);
    event CreditDueManagerImplChanged(address oldAddress, address newAddress);
    event ReceivableImplChanged(address oldAddress, address newAddress);
    event CalendarAddressChanged(address oldAddress, address newAddress);
    event ReceivableBackedCreditLineImplChanged(address oldAddress, address newAddress);
    event FixedSeniorYieldTranchesPolicyImplChanged(address oldAddress, address newAddress);
    event RiskAdjustedTranchesPolicyImpl(address oldAddress, address newAddress);
    event CreditLineManagerImplChanged(address oldAddress, address newAddress);
    event ReceivableBackedCreditLineManagerImplChanged(address oldAddress, address newAddress);
    event ReceivableFactoringCreditManagerImplChanged(address oldAddress, address newAddress);
    event CreditLineImplChanged(address oldAddress, address newAddress);
    event ReceivableFactoringCreditImplChanged(address oldAddress, address newAddress);

    // deployer events
    event DeployerAdded(address deployerAddress);
    event DeployerRemoved(address deployerAddress);

    // Pool events
    event PoolCreated(address poolAddress, string poolName);
    event PoolAdded(uint256 poolId, address poolAddress, string poolName);
    event PoolStatusUpdated(
        uint256 poolId,
        address poolAddress,
        string poolName,
        PoolStatus oldAddress,
        PoolStatus newStatus
    );

    event ReceivableCreated(address receivableAddress);

    event TimelockAddedToPool(uint256 poolId, address poolAddress, address timelockAddress);

    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize function grants DEFAULT_ADMIN_ROLE and DEPLOYER_ROLE to the deployer.
     * @dev After deployment and initial setup of the factory, the deploy should grant the
     * DEFAULT_ADMIN_ROLE to the protocol owner, meanwhile renounce the role from the deployer.
     * @param humaConfigAddress_ The address of the HumaConfig contract.
     */
    function initialize(address humaConfigAddress_) external initializer {
        poolId = 0;
        humaConfigAddress = humaConfigAddress_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(DEPLOYER_ROLE, msg.sender);
        __AccessControl_init();
        __UUPSUpgradeable_init();
    }

    // Add a deployer account
    function addDeployer(address account) external {
        _notZeroAddress(account);
        _onlyFactoryAdmin(msg.sender);
        _grantRole(DEPLOYER_ROLE, account);
        emit DeployerAdded(account);
    }

    // Remove a deployer account
    function removeDeployer(address account) external {
        _onlyFactoryAdmin(msg.sender);
        _revokeRole(DEPLOYER_ROLE, account);
        emit DeployerRemoved(account);
    }

    // set a calendar address for the factory, so the newly deployed pool will use this calendar
    function setCalendarAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = calendarAddress;
        calendarAddress = newAddress;
        emit CalendarAddressChanged(oldAddress, newAddress);
    }

    /**
     * @dev For protocol owner to set the implementation addresses
     */
    function setFixedSeniorYieldTranchesPolicyImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = fixedSeniorYieldTranchesPolicyImplAddress;
        fixedSeniorYieldTranchesPolicyImplAddress = newAddress;
        emit FixedSeniorYieldTranchesPolicyImplChanged(oldAddress, newAddress);
    }

    function setRiskAdjustedTranchesPolicyImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = riskAdjustedTranchesPolicyImplAddress;
        riskAdjustedTranchesPolicyImplAddress = newAddress;
        emit RiskAdjustedTranchesPolicyImpl(oldAddress, newAddress);
    }

    function setCreditLineImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditLineImplAddress;
        creditLineImplAddress = newAddress;
        emit CreditLineImplChanged(oldAddress, newAddress);
    }

    function setReceivableBackedCreditLineImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableBackedCreditLineImplAddress;
        receivableBackedCreditLineImplAddress = newAddress;
        emit ReceivableBackedCreditLineImplChanged(oldAddress, newAddress);
    }

    function setReceivableFactoringCreditImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableFactoringCreditImplAddress;
        receivableFactoringCreditImplAddress = newAddress;
        emit ReceivableFactoringCreditImplChanged(oldAddress, newAddress);
    }

    function setCreditLineManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditLineManagerImplAddress;
        creditLineManagerImplAddress = newAddress;
        emit CreditLineManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableBackedCreditLineManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableBackedCreditLineManagerImplAddress;
        receivableBackedCreditLineManagerImplAddress = newAddress;
        emit ReceivableBackedCreditLineManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableFactoringCreditManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableFactoringCreditManagerImplAddress;
        receivableFactoringCreditManagerImplAddress = newAddress;
        emit ReceivableFactoringCreditManagerImplChanged(oldAddress, newAddress);
    }

    function setPoolConfigImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolConfigImplAddress;
        poolConfigImplAddress = newAddress;
        emit PoolConfigImplChanged(oldAddress, newAddress);
    }

    function setPoolFeeManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolFeeManagerImplAddress;
        poolFeeManagerImplAddress = newAddress;
        emit PoolFeeManagerImplChanged(oldAddress, newAddress);
    }

    function setPoolImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolImplAddress;
        poolImplAddress = newAddress;
        emit PoolImplChanged(oldAddress, newAddress);
    }

    function setPoolSafeImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolSafeImplAddress;
        poolSafeImplAddress = newAddress;
        emit PoolSafeImplChanged(oldAddress, newAddress);
    }

    function setFirstLossCoverImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = firstLossCoverImplAddress;
        firstLossCoverImplAddress = newAddress;
        emit FirstLossCoverImplChanged(oldAddress, newAddress);
    }

    function setEpochManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = epochManagerImplAddress;
        epochManagerImplAddress = newAddress;
        emit EpochManagerImplChanged(oldAddress, newAddress);
    }

    function setTrancheVaultImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = trancheVaultImplAddress;
        trancheVaultImplAddress = newAddress;
        emit TrancheVaultImplChanged(oldAddress, newAddress);
    }

    function setCreditDueManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditDueManagerImplAddress;
        creditDueManagerImplAddress = newAddress;
        emit CreditDueManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableImpl;
        receivableImpl = newAddress;
        emit ReceivableImplChanged(oldAddress, newAddress);
    }

    /**
     * @dev If the deployer has details about the first loss covers of a pool,
     * the deployer can set them using this function after a pool is created
     */
    function setFirstLossCover(
        address poolConfigAddress,
        uint8 poolCoverIndex,
        uint16 coverRatePerLossInBps,
        uint96 coverCapPerLoss,
        uint96 maxLiquidity,
        uint96 minLiquidity,
        uint16 riskYieldMultiplierInBps,
        string memory firstLossCoverName,
        string memory firstLossCoverSymbol
    ) external {
        _onlyDeployer(msg.sender);
        _setFirstLossCover(
            PoolConfig(poolConfigAddress),
            poolCoverIndex,
            coverRatePerLossInBps,
            coverCapPerLoss,
            maxLiquidity,
            minLiquidity,
            riskYieldMultiplierInBps,
            firstLossCoverName,
            firstLossCoverSymbol
        );
    }

    /**
     * @dev The first step of deploying a pool
     * @param poolName The name of the pool
     * @param assetTokenAddress The address of the asset token, e.g. USDC
     * @param receivableAddress The address of the receivable, can be provided by the pool owner or using Huma implementation
     * @param tranchesPolicyType The type of tranches policy, can be "fixed" or "adjusted"
     * @param creditType The type of credit, can be "receivablebacked", "receivablefactoring" or "creditline"
     * TODO: Upgrade the factory when there's more credit types or tranches policy types
     */
    function deployPool(
        string memory poolName,
        address assetTokenAddress,
        address receivableAddress,
        string memory tranchesPolicyType,
        string memory creditType
    ) external {
        _onlyDeployer(msg.sender);
        (address poolConfigAddress, address[] memory poolAddresses) = _createPoolContracts(
            poolName,
            assetTokenAddress,
            tranchesPolicyType,
            creditType
        );
        PoolConfig poolConfig = PoolConfig(poolConfigAddress);

        if (receivableAddress != address(0)) {
            poolConfig.setReceivableAsset(receivableAddress);
        }

        // First Loss Cover index [0, 1, 2] are reserved for borrower, insurance and admin
        // all fields are set to 0 by default, and can be changed by pool owner later
        // or by the deployer if the pool owner provides the details
        _setFirstLossCover(poolConfig, 0, 0, 0, 0, 0, 0, "Borrower First Loss Cover", "BFLC");
        _setFirstLossCover(poolConfig, 1, 0, 0, 0, 0, 0, "Insurance First Loss Cover", "IFLC");
        _setFirstLossCover(poolConfig, 2, 0, 0, 0, 0, 0, "Admin First Loss Cover", "AFLC");
        for (uint8 i = 3; i <= 12; i++) {
            // when index is 8 or 9, it is senior or junior tranche vault
            // trancheVault uses different initialize function
            if (i == 8) {
                IVaultLike(poolAddresses[i]).initialize(
                    "Senior Tranche Vault",
                    "STV",
                    poolConfig,
                    0
                );
            } else if (i == 9) {
                IVaultLike(poolAddresses[i]).initialize(
                    "Junior Tranche Vault",
                    "JTV",
                    poolConfig,
                    1
                );
            } else {
                IPoolConfigCacheLike(poolAddresses[i]).initialize(poolConfigAddress);
            }
        }
        _registerPool(poolAddresses[3], poolName, poolConfigAddress, address(0));
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    function setPoolSettings(
        uint256 poolId_,
        uint96 maxCreditLine,
        uint96 minDepositAmount,
        PayPeriodDuration payPeriodDuration,
        uint8 latePaymentGracePeriodInDays,
        uint16 defaultGracePeriodInDays,
        uint16 advanceRateInBps,
        bool receivableAutoApproval
    ) external {
        _onlyDeployer(msg.sender);
        PoolSettings memory settings = PoolSettings({
            maxCreditLine: maxCreditLine,
            minDepositAmount: minDepositAmount,
            payPeriodDuration: payPeriodDuration,
            latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
            defaultGracePeriodInDays: defaultGracePeriodInDays,
            advanceRateInBps: advanceRateInBps,
            receivableAutoApproval: receivableAutoApproval
        });
        PoolConfig(_pools[poolId_].poolConfigAddress).setPoolSettings(settings);
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    function setLPConfig(
        uint256 poolId_,
        uint96 liquidityCap,
        uint8 maxSeniorJuniorRatio,
        uint16 fixedSeniorYieldInBps,
        uint16 tranchesRiskAdjustmentInBps,
        uint16 withdrawalLockoutPeriodInDays
    ) external {
        _onlyDeployer(msg.sender);
        LPConfig memory lpConfig = LPConfig({
            liquidityCap: liquidityCap,
            maxSeniorJuniorRatio: maxSeniorJuniorRatio,
            fixedSeniorYieldInBps: fixedSeniorYieldInBps,
            tranchesRiskAdjustmentInBps: tranchesRiskAdjustmentInBps,
            withdrawalLockoutPeriodInDays: withdrawalLockoutPeriodInDays
        });
        PoolConfig(_pools[poolId_].poolConfigAddress).setLPConfig(lpConfig);
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    function setFees(
        uint256 poolId_,
        uint96 frontLoadingFeeFlat,
        uint16 frontLoadingFeeBps,
        uint16 yieldInBps,
        uint16 minPrincipalRateInBps,
        uint16 lateFeeBps,
        uint256 poolOwnerRewardRate,
        uint256 poolOwnerLiquidityRate,
        uint256 eaRewardRate,
        uint256 eaLiquidityRate
    ) external {
        _onlyDeployer(msg.sender);
        FrontLoadingFeesStructure memory frontLoadingFees = FrontLoadingFeesStructure({
            frontLoadingFeeFlat: frontLoadingFeeFlat,
            frontLoadingFeeBps: frontLoadingFeeBps
        });
        PoolConfig(_pools[poolId_].poolConfigAddress).setFrontLoadingFees(frontLoadingFees);
        FeeStructure memory fees = FeeStructure({
            yieldInBps: yieldInBps,
            minPrincipalRateInBps: minPrincipalRateInBps,
            lateFeeBps: lateFeeBps
        });
        PoolConfig(_pools[poolId_].poolConfigAddress).setFeeStructure(fees);
        PoolConfig(_pools[poolId_].poolConfigAddress).setPoolOwnerRewardsAndLiquidity(
            poolOwnerRewardRate,
            poolOwnerLiquidityRate
        );
        PoolConfig(_pools[poolId_].poolConfigAddress).setEARewardsAndLiquidity(
            eaRewardRate,
            eaLiquidityRate
        );
    }

    // After deploying a new pool, the deployer needs to set pool parameters using this function
    // if the deployer has the details of pool operators, the deployer can set them using this function
    // otherwise, the pool owner can set them later
    function addPoolOperator(uint256 poolId_, address poolOperator) external {
        _onlyDeployer(msg.sender);
        _notZeroAddress(poolOperator);
        PoolConfig(_pools[poolId_].poolConfigAddress).grantRole(
            PoolConfig(_pools[poolId_].poolConfigAddress).POOL_OPERATOR_ROLE(),
            poolOperator
        );
    }

    // Huma requires all pools to have a timelock controller, this function adds a timelock controller to a pool
    function addTimelock(
        uint256 poolId_,
        address[] memory poolOwners,
        address[] memory poolExecutors
    ) external {
        _onlyDeployer(msg.sender);
        address timelockAddress = LibTimelockController.addTimelockController(
            0,
            poolOwners,
            poolExecutors,
            address(0)
        );

        PoolConfig poolConfig = PoolConfig(_pools[poolId_].poolConfigAddress);
        poolConfig.grantRole(poolConfig.DEFAULT_ADMIN_ROLE(), timelockAddress);
        poolConfig.renounceRole(poolConfig.DEFAULT_ADMIN_ROLE(), address(this));

        emit TimelockAddedToPool(poolId_, _pools[poolId_].poolAddress, timelockAddress);
        _pools[poolId_].poolTimelock = timelockAddress;
    }

    // After pool parameters are set, and timelock is added, the pool status can be updated to Initialized
    // which means the pool is ready for operation
    function updatePoolStatus(uint256 poolId_, PoolStatus newStatus) external {
        _onlyDeployer(msg.sender);
        _validPoolId(poolId_);
        emit PoolStatusUpdated(
            poolId_,
            _pools[poolId_].poolAddress,
            _pools[poolId_].poolName,
            _pools[poolId_].poolStatus,
            newStatus
        );
        _pools[poolId_].poolStatus = newStatus;
    }

    /**
     * @dev Adds a new receivable contract with the specified owner.
     * Only the deployer of the contract can call this function.
     * The `receivableOwner` parameter must be a non-zero address.
     * @custom:access The deployer is granted the DEFAULT_ADMIN_ROLE on the receivable contract,
     * @custom:access and then renounces the role, transferring ownership to `receivableOwner`.
     * Emits a `ReceivableCreated` event with the address of the newly created receivable contract.
     */
    function addReceivable(address receivableOwner) external {
        _onlyDeployer(msg.sender);
        _notZeroAddress(receivableOwner);
        address receivable = _addProxy(receivableImpl, abi.encodeWithSignature("initialize()"));
        AccessControlUpgradeable receivableContract = AccessControlUpgradeable(receivable);
        receivableContract.grantRole(receivableContract.DEFAULT_ADMIN_ROLE(), receivableOwner);
        receivableContract.renounceRole(receivableContract.DEFAULT_ADMIN_ROLE(), address(this));
        emit ReceivableCreated(receivable);
    }

    // Returns the corresponding poolRecord for a poolId
    function checkPool(uint256 poolId_) external view returns (PoolRecord memory) {
        _validPoolId(poolId_);
        return _pools[poolId_];
    }

    function _validPoolId(uint256 poolId_) internal view {
        if (poolId_ == 0 || poolId_ > poolId) {
            revert Errors.InvalidPoolId();
        }
    }

    function _onlyFactoryAdmin(address account) internal view {
        if (!hasRole(DEFAULT_ADMIN_ROLE, account)) {
            revert Errors.AdminRequired();
        }
    }

    function _onlyDeployer(address account) internal view {
        if (!hasRole(DEPLOYER_ROLE, account)) {
            revert Errors.DeployerRequired();
        }
    }

    // Only DEFAULT_ADMIN_ROLE can upgrade the implementation addresses
    function _authorizeUpgrade(address) internal view override {
        _onlyFactoryAdmin(msg.sender);
    }

    function _notZeroAddress(address newAddress) internal pure {
        if (newAddress == address(0)) revert Errors.ZeroAddressProvided();
    }

    // adds a pool in PoolRecord
    function _registerPool(
        address poolAddress,
        string memory poolName,
        address poolConfigAddress,
        address poolTimelockAddress
    ) private {
        poolId = poolId + 1;
        _pools[poolId] = PoolRecord(
            poolId,
            poolAddress,
            poolName,
            PoolStatus.Created,
            poolConfigAddress,
            poolTimelockAddress
        );
        emit PoolAdded(poolId, poolAddress, poolName);
    }

    function _setFirstLossCover(
        PoolConfig poolConfig,
        uint8 poolCoverIndex,
        uint16 coverRatePerLossInBps,
        uint96 coverCapPerLoss,
        uint96 maxLiquidity,
        uint96 minLiquidity,
        uint16 riskYieldMultiplierInBps,
        string memory firstLossCoverName,
        string memory firstLossCoverSymbol
    ) private {
        _notZeroAddress(address(poolConfig));
        address firstLossCover = _addFirstLossCover(
            firstLossCoverName,
            firstLossCoverSymbol,
            poolConfig
        );
        FirstLossCoverConfig memory config = FirstLossCoverConfig(
            coverRatePerLossInBps,
            coverCapPerLoss,
            maxLiquidity,
            minLiquidity,
            riskYieldMultiplierInBps
        );
        poolConfig.setFirstLossCover(poolCoverIndex, firstLossCover, config);
    }

    // add a proxy
    function _addProxy(address implAddress, bytes memory calldata_) private returns (address) {
        _notZeroAddress(implAddress);
        ERC1967Proxy proxy = new ERC1967Proxy(implAddress, calldata_);
        return address(proxy);
    }

    // add poolConfig proxy
    function _addPoolConfig(
        string memory poolName,
        address[] memory poolAddresses
    ) private returns (address) {
        _notZeroAddress(poolConfigImplAddress);
        address poolConfig = _addProxy(
            poolConfigImplAddress,
            abi.encodeWithSignature("initialize(string,address[])", poolName, poolAddresses)
        );
        return poolConfig;
    }

    // add poolFeeManager proxy
    function _addPoolFeeManager() private returns (address) {
        _notZeroAddress(poolFeeManagerImplAddress);
        address poolFeeManager = _addProxy(poolFeeManagerImplAddress, "");
        return poolFeeManager;
    }

    // add pool proxy
    function _addPool() private returns (address) {
        _notZeroAddress(poolImplAddress);
        address pool = _addProxy(poolImplAddress, "");
        return pool;
    }

    // add pool safe proxy
    function _addPoolSafe() private returns (address) {
        _notZeroAddress(poolSafeImplAddress);
        address poolSafe = _addProxy(poolSafeImplAddress, "");
        return poolSafe;
    }

    // add firstLossCover proxy
    function _addFirstLossCover(
        string memory firstLossCoverName,
        string memory firstLossCoverSymbol,
        PoolConfig poolConfig
    ) private returns (address) {
        _notZeroAddress(firstLossCoverImplAddress);
        _notZeroAddress(address(poolConfig));
        address firstLossCover = _addProxy(
            firstLossCoverImplAddress,
            abi.encodeWithSignature(
                "initialize(string,string,address)",
                firstLossCoverName,
                firstLossCoverSymbol,
                poolConfig
            )
        );
        return firstLossCover;
    }

    // add tranchesPolicy proxies
    function _addTranchesPolicy(address tranchesPolicyImpl) private returns (address) {
        _notZeroAddress(tranchesPolicyImpl);
        address tranchesPolicy = _addProxy(tranchesPolicyImpl, "");
        return tranchesPolicy;
    }

    // add epochManager proxy
    function _addEpochManager() private returns (address) {
        _notZeroAddress(epochManagerImplAddress);
        address epochManager = _addProxy(epochManagerImplAddress, "");
        return epochManager;
    }

    // add trancheVault proxy
    function _addTrancheVault() private returns (address) {
        _notZeroAddress(trancheVaultImplAddress);
        address trancheVault = _addProxy(trancheVaultImplAddress, "");
        return trancheVault;
    }

    // add credit proxy
    function _addCredit(address creditImplAddress) private returns (address) {
        _notZeroAddress(creditImplAddress);
        address credit = _addProxy(creditImplAddress, "");
        return credit;
    }

    // add creditDueManager proxy
    function _addCreditDueManager() private returns (address) {
        _notZeroAddress(creditDueManagerImplAddress);
        address creditDueManager = _addProxy(creditDueManagerImplAddress, "");
        return creditDueManager;
    }

    // add creditManager proxy
    function _addCreditManager(address creditManagerImplAddress) private returns (address) {
        _notZeroAddress(creditManagerImplAddress);
        address creditManager = _addProxy(creditManagerImplAddress, "");
        return creditManager;
    }

    /**
     * @dev Creates a set of pool contracts for a given pool name, asset token address, tranches policy type, and credit type.
     * @param poolName The name of the pool.
     * @param assetTokenAddress The address of the asset token.
     * @param tranchesPolicyType The type of tranches policy.
     * @param creditType The type of credit.
     * @return poolConfigAddress The address of the pool configuration contract.
     * @return poolAddresses An array of addresses representing the pool contracts.
     * The array index corresponds to the initialize function in PoolConfig.sol
     */
    function _createPoolContracts(
        string memory poolName,
        address assetTokenAddress,
        string memory tranchesPolicyType,
        string memory creditType
    ) private returns (address, address[] memory) {
        _onlyDeployer(msg.sender);
        address[] memory poolAddresses = new address[](13); // 13 is the number of contracts in a pool
        poolAddresses[0] = humaConfigAddress;
        poolAddresses[1] = assetTokenAddress;
        poolAddresses[2] = calendarAddress;
        poolAddresses[3] = _addPool();
        poolAddresses[4] = _addPoolSafe();
        poolAddresses[5] = _addPoolFeeManager();

        if (keccak256(bytes(tranchesPolicyType)) == keccak256(bytes("fixed"))) {
            poolAddresses[6] = _addTranchesPolicy(fixedSeniorYieldTranchesPolicyImplAddress);
        } else if (keccak256(bytes(tranchesPolicyType)) == keccak256(bytes("adjusted"))) {
            poolAddresses[6] = _addTranchesPolicy(riskAdjustedTranchesPolicyImplAddress);
        } else {
            revert Errors.InvalidTranchesPolicyType();
        }

        poolAddresses[7] = _addEpochManager();
        poolAddresses[8] = _addTrancheVault(); // senior tranche vault
        poolAddresses[9] = _addTrancheVault(); // junior tranche vault
        poolAddresses[11] = _addCreditDueManager();

        if (keccak256(bytes(creditType)) == keccak256(bytes("receivablebacked"))) {
            poolAddresses[10] = _addCredit(receivableBackedCreditLineImplAddress);
            poolAddresses[12] = _addCreditManager(receivableBackedCreditLineManagerImplAddress);
        } else if (keccak256(bytes(creditType)) == keccak256(bytes("receivablefactoring"))) {
            poolAddresses[10] = _addCredit(receivableFactoringCreditImplAddress);
            poolAddresses[12] = _addCreditManager(receivableFactoringCreditManagerImplAddress);
        } else if (keccak256(bytes(creditType)) == keccak256(bytes("creditline"))) {
            poolAddresses[10] = _addCredit(creditLineImplAddress);
            poolAddresses[12] = _addCreditManager(creditLineManagerImplAddress);
        } else {
            revert Errors.InvalidCreditType();
        }
        address poolConfigAddress = _addPoolConfig(poolName, poolAddresses);
        emit PoolCreated(poolAddresses[3], poolName);
        return (poolConfigAddress, poolAddresses);
    }
}
