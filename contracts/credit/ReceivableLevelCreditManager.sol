// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditManager} from "./CreditManager.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {Errors} from "../Errors.sol";
import {ReceivableInput, PayPeriodDuration, CreditConfig} from "./CreditStructs.sol";
import {IReceivableLevelCreditManager} from "./interfaces/IReceivableLevelCreditManager.sol";

contract ReceivableLevelCreditManager is
    CreditManager,
    AccessControlUpgradeable,
    IReceivableLevelCreditManager
{
    bytes32 public constant PAYER_ROLE = keccak256("PAYER");
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER");

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

    function initialize(PoolConfig _poolConfig) public virtual override initializer {
        __AccessControl_init();
        _initialize(_poolConfig);
    }

    function addRole(bytes32 role, address account) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO operator?
        if (account == address(0)) revert Errors.zeroAddressProvided();
        _grantRole(role, account);
    }

    function removeRole(bytes32 role, address account) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO
        if (account == address(0)) revert Errors.zeroAddressProvided();
        _revokeRole(role, account);
    }

    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps
    ) external virtual onlyRole(APPROVER_ROLE) {
        poolConfig.onlyProtocolAndPoolOn();
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

    function refreshCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _refreshCredit(creditHash);
    }

    function triggerDefault(
        uint256 receivableId
    ) external virtual returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return _triggerDefault(creditHash);
    }

    function closeCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _closeCredit(creditHash);
    }

    function pauseCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _pauseCredit(creditHash);
    }

    function unpauseCredit(uint256 receivableId) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _unpauseCredit(creditHash);
    }

    function updateYield(uint256 receivableId, uint256 yieldInBps) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _updateYield(creditHash, yieldInBps);
    }

    function updateLimitAndCommitment(
        uint256 receivableId,
        uint256 creditLimit,
        uint256 committedAmount
    ) external {
        bytes32 creditHash = _getCreditHash(receivableId);
        _updateLimitAndCommitment(creditHash, creditLimit, committedAmount);
    }

    function extendRemainingPeriod(uint256 receivableId, uint256 numOfPeriods) external virtual {
        _onlyEAServiceAccount();
        bytes32 creditHash = _getCreditHash(receivableId);
        _extendRemainingPeriod(creditHash, numOfPeriods);
    }

    function waiveLateFee(uint256 receivableId, uint256 waivedAmount) external virtual {
        bytes32 creditHash = _getCreditHash(receivableId);
        _waiveLateFee(creditHash, waivedAmount);
    }

    function getReceivableCreditConfig(
        uint256 receivableId
    ) external view returns (CreditConfig memory) {
        bytes32 creditHash = _getCreditHash(receivableId);
        return _creditConfigMap[creditHash];
    }

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
