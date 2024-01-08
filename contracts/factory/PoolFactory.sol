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

interface IFirstLossCoverLike {
    function initialize(string memory name, string memory symbol, PoolConfig _poolConfig) external;
}

interface ITrancheVaultLike {
    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external;
}

contract PoolFactory is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    /**
     * @dev Represents the status of a pool.
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
    address public HUMA_CONFIG_ADDRESS;
    address public calendarAddress;
    address public fixedSeniorYieldTranchesPolicyImplAddress;
    address public riskAdjustedTranchesPolicyImplAddress;

    // Credit implementation addresses
    address public creditLineImplAddress;
    address public receivableBackedCreditLineImplAddress;
    address public receivableFactoringCreditImplAddress;
    address public borrowerLevelCreditmanagerImplAddress;
    address public receivableBackedCreditLineManagerImplAddress;
    address public receivableLevelCreditManagerImplAddress;

    // pool implementation addresses
    address public poolConfigImplAddress;
    address public poolFeeManagerImplAddress;
    address public poolImplAddress;
    address public poolSafeImplAddress;
    address public firstLossCoverImplAddress;
    address public epochManagerImplAddress;
    address public trancheVaultImplAddress;
    address public creditDueManagerImplAddress;
    address public receivableImpl;

    // poolId => PoolRecord
    mapping(uint256 => PoolRecord) private pools;

    // events for implementation address changes
    event poolConfigImplChanged(address oldAddress, address newAddress);
    event poolFeeManagerImplChanged(address oldAddress, address newAddress);
    event poolImplChanged(address oldAddress, address newAddress);
    event poolSafeImplChanged(address oldAddress, address newAddress);
    event firstLossCoverImplChanged(address oldAddress, address newAddress);
    event tranchesPolicyImplChanged(address oldAddress, address newAddress);
    event epochManagerImplChanged(address oldAddress, address newAddress);
    event trancheVaultImplChanged(address oldAddress, address newAddress);
    event creditDueManagerImplChanged(address oldAddress, address newAddress);
    event receivableImplChanged(address oldAddress, address newAddress);
    event calendarAddressChanged(address oldAddress, address newAddress);
    event receivableBackedCreditLineImplChanged(address oldAddress, address newAddress);
    event fixedSeniorYieldTranchesPolicyImplChanged(address oldAddress, address newAddress);
    event riskAdjustedTranchesPolicyImpl(address oldAddress, address newAddress);
    event borrowerLevelCreditmanagerImplChanged(address oldAddress, address newAddress);
    event receivableBackedCreditLineManagerImplChanged(address oldAddress, address newAddress);
    event receivableLevelCreditManagerImplChanged(address oldAddress, address newAddress);
    event creditLineImplChanged(address oldAddress, address newAddress);
    event receivableFactoringCreditImplChanged(address oldAddress, address newAddress);

    // deployer events
    event DeployerAdded(address deployerAddress);
    event DeployerRemoved(address deployerAddress);

    // Pool events
    event PoolCreated(address poolAddress, string poolName);
    event PoolAdded(uint256 poolId, address poolAddress, string poolName);
    event PoolClosed(uint256 poolId, address poolAddress, string poolName);

    event PoolStatusUpdated(uint256 poolId, PoolStatus oldStatus, PoolStatus newStatus);
    event timelockAddedtoPool(uint256 poolId, address poolAddress, address timelockAddress);

    constructor() {
        _disableInitializers();
    }

    function initialize(address _humaConfigAddress) external initializer {
        poolId = 0;
        HUMA_CONFIG_ADDRESS = _humaConfigAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(DEPLOYER_ROLE, msg.sender);
        __AccessControl_init();
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

    // Add multiple deployer accounts
    function addDeployers(address[] memory accounts) external {
        _onlyFactoryAdmin(msg.sender);
        for (uint256 i = 0; i < accounts.length; i++) {
            _notZeroAddress(accounts[i]);
            _grantRole(DEPLOYER_ROLE, accounts[i]);
            emit DeployerAdded(accounts[i]);
        }
    }

    // set protocol and implementation addresses
    function setCalendarAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = calendarAddress;
        calendarAddress = newAddress;
        emit calendarAddressChanged(oldAddress, newAddress);
    }

    /**
     * @dev For protocol owner to set the implementation addresses
     */
    function setFixedSeniorYieldTranchesPolicyImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = fixedSeniorYieldTranchesPolicyImplAddress;
        fixedSeniorYieldTranchesPolicyImplAddress = newAddress;
        emit fixedSeniorYieldTranchesPolicyImplChanged(oldAddress, newAddress);
    }

    function setRiskAdjustedTranchesPolicyImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = riskAdjustedTranchesPolicyImplAddress;
        riskAdjustedTranchesPolicyImplAddress = newAddress;
        emit riskAdjustedTranchesPolicyImpl(oldAddress, newAddress);
    }

    function setCreditLineImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditLineImplAddress;
        creditLineImplAddress = newAddress;
        emit creditLineImplChanged(oldAddress, newAddress);
    }

    function setReceivableBackedCreditLineImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableBackedCreditLineImplAddress;
        receivableBackedCreditLineImplAddress = newAddress;
        emit receivableBackedCreditLineImplChanged(oldAddress, newAddress);
    }

    function setReceivableFactoringCreditImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableFactoringCreditImplAddress;
        receivableFactoringCreditImplAddress = newAddress;
        emit receivableFactoringCreditImplChanged(oldAddress, newAddress);
    }

    function setBorrowerLevelCreditManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = borrowerLevelCreditmanagerImplAddress;
        borrowerLevelCreditmanagerImplAddress = newAddress;
        emit borrowerLevelCreditmanagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableBackedCreditLineManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableBackedCreditLineManagerImplAddress;
        receivableBackedCreditLineManagerImplAddress = newAddress;
        emit receivableBackedCreditLineManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableLevelCreditManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableLevelCreditManagerImplAddress;
        receivableLevelCreditManagerImplAddress = newAddress;
        emit receivableLevelCreditManagerImplChanged(oldAddress, newAddress);
    }

    function setPoolConfigImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolConfigImplAddress;
        poolConfigImplAddress = newAddress;
        emit poolConfigImplChanged(oldAddress, newAddress);
    }

    function setPoolFeeManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolFeeManagerImplAddress;
        poolFeeManagerImplAddress = newAddress;
        emit poolFeeManagerImplChanged(oldAddress, newAddress);
    }

    function setPoolImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolImplAddress;
        poolImplAddress = newAddress;
        emit poolImplChanged(oldAddress, newAddress);
    }

    function setPoolSafeImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = poolSafeImplAddress;
        poolSafeImplAddress = newAddress;
        emit poolSafeImplChanged(oldAddress, newAddress);
    }

    function setFirstLossCoverImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = firstLossCoverImplAddress;
        firstLossCoverImplAddress = newAddress;
        emit firstLossCoverImplChanged(oldAddress, newAddress);
    }

    function setEpochManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = epochManagerImplAddress;
        epochManagerImplAddress = newAddress;
        emit epochManagerImplChanged(oldAddress, newAddress);
    }

    function setTrancheVaultImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = trancheVaultImplAddress;
        trancheVaultImplAddress = newAddress;
        emit trancheVaultImplChanged(oldAddress, newAddress);
    }

    function setCreditDueManagerImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = creditDueManagerImplAddress;
        creditDueManagerImplAddress = newAddress;
        emit creditDueManagerImplChanged(oldAddress, newAddress);
    }

    function setReceivableImplAddress(address newAddress) external {
        _onlyFactoryAdmin(msg.sender);
        _notZeroAddress(newAddress);
        address oldAddress = receivableImpl;
        receivableImpl = newAddress;
        emit receivableImplChanged(oldAddress, newAddress);
    }

    function setFirstLossCover(
        address poolConfigAddress,
        uint8 index,
        uint16 coverRatePerLossInBps,
        uint96 coverCapPerLoss,
        uint96 maxLiquidity,
        uint96 minLiquidity,
        uint16 riskYieldMultiplierInBps
    ) external {
        _onlyDeployer(msg.sender);
        address firstLossCover = _addFirstLossCover();
        FirstLossCoverConfig memory config = FirstLossCoverConfig(
            coverRatePerLossInBps,
            coverCapPerLoss,
            maxLiquidity,
            minLiquidity,
            riskYieldMultiplierInBps
        );
        _setFirstLossCover(poolConfigAddress, firstLossCover, index, config);
    }

    function deployPool(
        string memory _poolName,
        address assetTokenAddress,
        string memory tranchesPolicyType,
        string memory creditType
    ) external {
        _onlyDeployer(msg.sender);
        (address poolConfigAddress, address[] memory poolAddresses) = _createPoolContracts(
            _poolName,
            assetTokenAddress,
            tranchesPolicyType,
            creditType
        );
        PoolConfig poolConfig = PoolConfig(poolConfigAddress);
        poolConfig.initialize(_poolName, poolAddresses);
        address receivable = _addReceivable();
        poolConfig.setReceivableAsset(receivable);

        address borrowerFirstLossCover = _addFirstLossCover();
        IFirstLossCoverLike(borrowerFirstLossCover).initialize(
            "Borrower First Loss Cover",
            "BFLC",
            poolConfig
        );
        _setFirstLossCover(
            poolConfigAddress,
            borrowerFirstLossCover,
            0,
            FirstLossCoverConfig(0, 0, 0, 0, 0)
        );
        address insuranceFirstLossCover = _addFirstLossCover();
        IFirstLossCoverLike(insuranceFirstLossCover).initialize(
            "Insurance First Loss Cover",
            "IFLC",
            poolConfig
        );
        _setFirstLossCover(
            poolConfigAddress,
            insuranceFirstLossCover,
            1,
            FirstLossCoverConfig(0, 0, 0, 0, 0)
        );
        address adminFirstLossCover = _addFirstLossCover();
        IFirstLossCoverLike(adminFirstLossCover).initialize(
            "Admin First Loss Cover",
            "AFLC",
            poolConfig
        );
        _setFirstLossCover(
            poolConfigAddress,
            adminFirstLossCover,
            2,
            FirstLossCoverConfig(0, 0, 0, 0, 0)
        );

        for (uint8 i = 3; i < 12; i++) {
            if (i == 8) {
                ITrancheVaultLike(poolAddresses[i]).initialize(
                    "Senior Tranche Vault",
                    "STV",
                    poolConfig,
                    0
                );
            } else if (i == 9) {
                ITrancheVaultLike(poolAddresses[i]).initialize(
                    "Junior Tranche Vault",
                    "JTV",
                    poolConfig,
                    1
                );
            } else {
                IPoolConfigCacheLike(poolAddresses[i]).initialize(poolConfigAddress);
            }
        }
        _registerPool(poolAddresses[3], _poolName, poolConfigAddress, address(0));
    }

    function setPoolSettings(
        uint256 _poolId,
        uint96 maxCreditLine,
        uint96 minDepositAmount,
        PayPeriodDuration payPeriodDuration,
        uint8 latePaymentGracePeriodIndays,
        uint16 defaultGracePeriodInDays,
        uint16 advanceRateInBps,
        bool receivableAutoApproval
    ) external {
        _onlyDeployer(msg.sender);
        PoolSettings memory settings = PoolSettings({
            maxCreditLine: maxCreditLine,
            minDepositAmount: minDepositAmount,
            payPeriodDuration: payPeriodDuration,
            latePaymentGracePeriodInDays: latePaymentGracePeriodIndays,
            defaultGracePeriodInDays: defaultGracePeriodInDays,
            advanceRateInBps: advanceRateInBps,
            receivableAutoApproval: receivableAutoApproval
        });
        PoolConfig(pools[_poolId].poolConfigAddress).setPoolSettings(settings);
    }

    function setLPConfig(
        uint256 _poolId,
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
        PoolConfig(pools[_poolId].poolConfigAddress).setLPConfig(lpConfig);
    }

    function setFees(
        uint256 _poolId,
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
        PoolConfig(pools[_poolId].poolConfigAddress).setFrontLoadingFees(frontLoadingFees);
        FeeStructure memory fees = FeeStructure({
            yieldInBps: yieldInBps,
            minPrincipalRateInBps: minPrincipalRateInBps,
            lateFeeBps: lateFeeBps
        });
        PoolConfig(pools[_poolId].poolConfigAddress).setFeeStructure(fees);
        PoolConfig(pools[_poolId].poolConfigAddress).setPoolOwnerRewardsAndLiquidity(
            poolOwnerRewardRate,
            poolOwnerLiquidityRate
        );
        PoolConfig(pools[_poolId].poolConfigAddress).setEARewardsAndLiquidity(
            eaRewardRate,
            eaLiquidityRate
        );
    }

    function addPoolOperator(uint256 _poolId, address poolOperator) external {
        _onlyDeployer(msg.sender);
        _notZeroAddress(poolOperator);
        PoolConfig(pools[_poolId].poolConfigAddress).grantRole(
            PoolConfig(pools[_poolId].poolConfigAddress).POOL_OPERATOR_ROLE(),
            poolOperator
        );
    }

    function addTimelock(
        uint256 _poolId,
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

        PoolConfig poolConfig = PoolConfig(pools[_poolId].poolConfigAddress);
        poolConfig.grantRole(poolConfig.DEFAULT_ADMIN_ROLE(), timelockAddress);
        poolConfig.renounceRole(poolConfig.DEFAULT_ADMIN_ROLE(), address(this));

        emit timelockAddedtoPool(_poolId, pools[_poolId].poolAddress, timelockAddress);
        pools[_poolId].poolTimelock = timelockAddress;
    }

    function updatePoolStatus(uint256 _poolId, PoolStatus newStatus) external {
        _onlyFactoryAdmin(msg.sender);
        if (_poolId == 0 || _poolId > poolId) {
            revert Errors.InvalidPoolId();
        }
        pools[_poolId].poolStatus = newStatus;
        if (newStatus == PoolStatus.Closed) {
            emit PoolClosed(_poolId, pools[_poolId].poolAddress, pools[_poolId].poolName);
        } else if (newStatus == PoolStatus.Initialized) {
            emit PoolStatusUpdated(_poolId, PoolStatus.Created, PoolStatus.Initialized);
        } else {
            revert Errors.InvalidPoolStatus();
        }
    }

    function checkPool(uint256 _poolId) external view returns (PoolRecord memory) {
        if (_poolId == 0 || _poolId > poolId) {
            revert Errors.InvalidPoolId();
        }
        return pools[_poolId];
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

    function _authorizeUpgrade(address) internal view override {
        _onlyFactoryAdmin(msg.sender);
    }

    function _notZeroAddress(address newAddress) internal pure {
        if (newAddress == address(0)) revert Errors.ZeroAddressProvided();
    }

    function _registerPool(
        address _poolAddress,
        string memory _poolName,
        address _poolConfigAddress,
        address _poolTimelockAddress
    ) private {
        poolId++;
        pools[poolId] = PoolRecord(
            poolId,
            _poolAddress,
            _poolName,
            PoolStatus.Created,
            _poolConfigAddress,
            _poolTimelockAddress
        );
        emit PoolAdded(poolId, _poolAddress, _poolName);
    }

    function _setFirstLossCover(
        address poolConfigAddress,
        address firstLossCover,
        uint8 index,
        FirstLossCoverConfig memory config
    ) private {
        PoolConfig(poolConfigAddress).setFirstLossCover(index, firstLossCover, config);
    }

    // add a proxy
    function _addProxy(address _implAddress) private returns (address) {
        if (_implAddress == address(0)) revert Errors.ZeroAddressProvided();
        ERC1967Proxy proxy = new ERC1967Proxy(_implAddress, "");
        return address(proxy);
    }

    // add poolConfig proxy
    function _addPoolConfig() private returns (address) {
        if (poolConfigImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address poolConfig = _addProxy(poolConfigImplAddress);
        return poolConfig;
    }

    // add poolFeeManager proxy
    function _addPoolFeeManager() private returns (address) {
        if (poolFeeManagerImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address poolFeeManager = _addProxy(poolFeeManagerImplAddress);
        return poolFeeManager;
    }

    // add pool proxy
    function _addPool() private returns (address) {
        if (poolImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address pool = _addProxy(poolImplAddress);
        return pool;
    }

    // add pool safe proxy
    function _addPoolSafe() private returns (address) {
        if (poolSafeImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address poolSafe = _addProxy(poolSafeImplAddress);
        return poolSafe;
    }

    // add firstLossCover proxy
    function _addFirstLossCover() private returns (address) {
        if (firstLossCoverImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address firstLossCover = _addProxy(firstLossCoverImplAddress);
        return firstLossCover;
    }

    // add tranchesPolicy proxies
    function _addTranchesPolicy(address tranchesPolicyImpl) private returns (address) {
        if (tranchesPolicyImpl == address(0)) revert Errors.ZeroAddressProvided();
        address tranchesPolicy = _addProxy(tranchesPolicyImpl);
        return tranchesPolicy;
    }

    // add epochManager proxy
    function _addEpochManager() private returns (address) {
        if (epochManagerImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address epochManager = _addProxy(epochManagerImplAddress);
        return epochManager;
    }

    // add trancheVault proxy
    function _addTrancheVault() private returns (address) {
        if (trancheVaultImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address trancheVault = _addProxy(trancheVaultImplAddress);
        return trancheVault;
    }

    // add credit proxy
    function _addCredit(address creditImplAddress) private returns (address) {
        if (creditImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address credit = _addProxy(creditImplAddress);
        return credit;
    }

    // add creditDueManager proxy
    function _addCreditDueManager() private returns (address) {
        if (creditDueManagerImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address creditDueManager = _addProxy(creditDueManagerImplAddress);
        return creditDueManager;
    }

    // add creditManager proxy
    function _addCreditManager(address creditManagerImplAddress) private returns (address) {
        if (creditManagerImplAddress == address(0)) revert Errors.ZeroAddressProvided();
        address creditManager = _addProxy(creditManagerImplAddress);
        return creditManager;
    }

    // add receivable proxy
    function _addReceivable() private returns (address) {
        if (receivableImpl == address(0)) revert Errors.ZeroAddressProvided();
        address receivable = _addProxy(receivableImpl);
        return receivable;
    }

    // create a new pool
    function _createPoolContracts(
        string memory _poolName,
        address assetTokenAddress,
        string memory tranchesPolicyType,
        string memory creditType
    ) private onlyRole(DEPLOYER_ROLE) returns (address, address[] memory) {
        address poolConfigAddress = _addPoolConfig();
        address[] memory poolAddresses = new address[](13);
        poolAddresses[0] = HUMA_CONFIG_ADDRESS;
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
            poolAddresses[12] = _addCreditManager(receivableLevelCreditManagerImplAddress);
        } else if (keccak256(bytes(creditType)) == keccak256(bytes("creditline"))) {
            poolAddresses[10] = _addCredit(creditLineImplAddress);
            poolAddresses[12] = _addCreditManager(borrowerLevelCreditmanagerImplAddress);
        } else {
            revert Errors.InvalidCreditType();
        }
        emit PoolCreated(poolAddresses[0], _poolName);
        return (poolConfigAddress, poolAddresses);
    }
}
