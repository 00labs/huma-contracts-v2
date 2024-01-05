// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditManager} from "./CreditManager.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PoolConfig} from "../common/PoolConfig.sol";
import {Errors} from "../common/Errors.sol";
import {ReceivableInput} from "./CreditStructs.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {IReceivableLevelCreditManager} from "./interfaces/IReceivableLevelCreditManager.sol";

contract ReceivableLevelCreditManager is
    CreditManager,
    AccessControlUpgradeable,
    IReceivableLevelCreditManager
{
    // This is the keccak-256 hash of "PAYER"
    bytes32 public constant PAYER_ROLE =
        0x2b2d2bc97bc0e0e953432f38c414b8b1c4b8f83a5dc170b7df98331f5de3fe5c;

    event ReceivableFactoringCreditApproved(
        address indexed borrower,
        bytes32 indexed creditHash,
        uint256 receivableId,
        uint256 receivableAmount,
        uint256 creditLimit,
        PayPeriodDuration periodDuration,
        uint256 remainingPeriods,
        uint256 yieldInBps
    );

    event PayerAdded(address indexed payer);

    event PayerRemoved(address indexed payer);

    function initialize(PoolConfig _poolConfig) public virtual override initializer {
        __AccessControl_init();
        _initialize(_poolConfig);
        __UUPSUpgradeable_init();
    }

    function addPayer(address payer) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO operator?
        if (payer == address(0)) revert Errors.zeroAddressProvided();
        _grantRole(PAYER_ROLE, payer);
        emit PayerAdded(payer);
    }

    function removePayer(address payer) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO
        if (payer == address(0)) revert Errors.zeroAddressProvided();
        _revokeRole(PAYER_ROLE, payer);
        emit PayerRemoved(payer);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps
    ) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();
        if (creditLimit > receivableInput.receivableAmount)
            revert Errors.insufficientReceivableAmount();

        bytes32 creditHash = _getCreditHash(receivableInput.receivableId);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            0,
            0,
            false
        );

        emit ReceivableFactoringCreditApproved(
            borrower,
            creditHash,
            receivableInput.receivableId,
            receivableInput.receivableAmount,
            creditLimit,
            getCreditConfig(creditHash).periodDuration,
            remainingPeriods,
            yieldInBps
        );
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function refreshCredit(uint256 receivableId) external virtual {
        poolConfig.onlyProtocolAndPoolOn();

        bytes32 creditHash = _getCreditHash(receivableId);
        _refreshCredit(creditHash);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function triggerDefault(
        uint256 receivableId
    ) external virtual returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss) {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableId);
        return _triggerDefault(creditHash);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function closeCredit(address borrower, uint256 receivableId) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        if (msg.sender != borrower && msg.sender != humaConfig.eaServiceAccount())
            revert Errors.notBorrowerOrEA();

        bytes32 creditHash = _getCreditHash(receivableId);
        onlyCreditBorrower(creditHash, borrower);
        _closeCredit(creditHash);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function pauseCredit(uint256 receivableId) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableId);
        _pauseCredit(creditHash);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function unpauseCredit(uint256 receivableId) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableId);
        _unpauseCredit(creditHash);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function updateYield(uint256 receivableId, uint256 yieldInBps) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableId);
        _updateYield(creditHash, yieldInBps);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function extendRemainingPeriod(uint256 receivableId, uint256 numOfPeriods) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableId);
        _extendRemainingPeriod(creditHash, numOfPeriods);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function waiveLateFee(uint256 receivableId, uint256 waivedAmount) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableId);
        _waiveLateFee(creditHash, waivedAmount);
    }

    /// @inheritdoc IReceivableLevelCreditManager
    function onlyPayer(address account, bytes32 creditHash) external view returns (address) {
        if (!hasRole(PAYER_ROLE, account)) revert Errors.permissionDeniedNotPayer();
        return _creditBorrowerMap[creditHash];
    }

    function _getCreditHash(
        uint256 receivableId
    ) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(credit), poolConfig.receivableAsset(), receivableId));
    }
}
