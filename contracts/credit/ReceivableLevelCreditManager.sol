// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditManager} from "./CreditManager.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PoolConfig} from "../PoolConfig.sol";
import {Errors} from "../Errors.sol";
import {ReceivableInput} from "./CreditStructs.sol";

contract ReceivableLevelCreditManager is CreditManager, AccessControlUpgradeable {
    bytes32 public constant PAYER_ROLE = keccak256("PAYER");

    function initialize(PoolConfig _poolConfig) public virtual override initializer {
        __AccessControl_init();
        _initialize(_poolConfig);
        __UUPSUpgradeable_init();
    }

    function addPayer(address payer) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO operator?
        if (payer == address(0)) revert Errors.zeroAddressProvided();
        _grantRole(PAYER_ROLE, payer);
    }

    function removePayer(address payer) external virtual {
        poolConfig.onlyPoolOwner(msg.sender); // TODO
        if (payer == address(0)) revert Errors.zeroAddressProvided();
        _revokeRole(PAYER_ROLE, payer);
    }

    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount
    ) external virtual {
        poolConfig.onlyProtocolAndPoolOn();
        _onlyEAServiceAccount();

        bytes32 creditHash = _getCreditHash(receivableInput.receivableId);
        _approveCredit(
            borrower,
            creditHash,
            creditLimit,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            false
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

    function onlyPayer(address account) external view {
        if (!hasRole(PAYER_ROLE, account)) revert Errors.permissionDeniedNotPayer();
    }

    function _getCreditHash(
        uint256 receivableId
    ) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(credit), poolConfig.receivableAsset(), receivableId));
    }
}
